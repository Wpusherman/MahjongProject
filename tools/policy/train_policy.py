#!/usr/bin/env python3
"""Train the obs-v2 policy network and export ONNX.

Input is the JSONL from tools/policy-dataset.js. The network is a small Mortal-
style ResNet over the 34-tile axis with four heads:

  discard : 34 tiles
  riichi  : 2 classes (declare / dama) on can-riichi discard states
  call    : 5 classes (pass / chi / pon / kan / ron)
  win     : 2 classes (accept / decline) at tsumo or ron opportunities

The split is by match, never by row. Metrics are per head and per call class.

  python tools/policy/train_policy.py --data test-results/policy-tenhou.jsonl --out-dir test-results/policy-model
  python tools/policy/train_policy.py --quick --data ... --out-dir ...
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CALL_NAMES = ["pass", "chi", "pon", "kan", "ron"]
CALL_INDEX = {name: i for i, name in enumerate(CALL_NAMES)}
FEATURE_VERSION = "obs-v2"


def read_rows(path: str, max_discard: int) -> list[dict]:
    rows = []
    discard_count = 0
    legacy = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("v") != FEATURE_VERSION:
                legacy += 1
                continue
            shape = row.get("shape") or {}
            if shape.get("tiles") != 34:
                raise ValueError("obs-v2 requires 34 tiles")
            label = row.get("label") or {}
            kind = label.get("kind")
            if kind == "discard":
                if max_discard and discard_count >= max_discard:
                    continue
                discard_count += 1
            row["_kind"] = kind
            rows.append(row)
    if legacy:
        print(f"warning: skipped {legacy} policy rows with feature version != {FEATURE_VERSION}; regenerate old shards", file=sys.stderr)
    if not rows:
        raise SystemExit(f"no {FEATURE_VERSION} policy rows found")
    return rows


def split_rows(rows: list[dict], val_fraction: float, seed: int) -> tuple[list[dict], list[dict]]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[str(row.get("match") or "match")].append(row)
    keys = sorted(groups)
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(keys))
    target = max(1, int(round(len(rows) * val_fraction)))
    val, count = set(), 0
    for index in order:
        key = keys[int(index)]
        val.add(key)
        count += len(groups[key])
        if count >= target:
            break
    train_rows = [r for key in keys if key not in val for r in groups[key]]
    val_rows = [r for key in keys if key in val for r in groups[key]]
    if not train_rows or not val_rows:
        cutoff = max(1, int(len(rows) * (1 - val_fraction)))
        return rows[:cutoff], rows[cutoff:] or rows[-1:]
    return train_rows, val_rows


def row_tensor(row: dict) -> tuple[np.ndarray, np.ndarray]:
    x = np.asarray(row["x"], dtype=np.float32)
    shape = row["shape"]
    channels, tiles, globals_n = int(shape["channels"]), int(shape["tiles"]), int(shape["globals"])
    return x[:channels * tiles].reshape(channels, tiles), x[channels * tiles:channels * tiles + globals_n]


def build_head(rows: list[dict], kind: str) -> dict:
    xs, ys, masks, extra = [], [], [], []
    for row in rows:
        label = row.get("label") or {}
        meta = row.get("meta") or {}
        if kind == "discard":
            if label.get("kind") != "discard":
                continue
            tiles, globals_ = row_tensor(row)
            xs.append((tiles, globals_))
            ys.append(int(label.get("tile", 0)))
            masks.append((tiles[0] > 0).astype(np.float32))
            extra.append(bool(label.get("forced")))
        elif kind == "riichi":
            if label.get("kind") != "discard" or not label.get("canRiichi"):
                continue
            tiles, globals_ = row_tensor(row)
            xs.append((tiles, globals_))
            ys.append(1 if label.get("riichi") else 0)
            extra.append(int(label.get("tile", 0)))
        elif kind == "call":
            if meta.get("kind") != "response" and label.get("kind") not in ("pass", "chi", "pon", "kan", "ron"):
                continue
            name = label.get("kind")
            if name not in CALL_INDEX:
                continue
            tiles, globals_ = row_tensor(row)
            xs.append((tiles, globals_))
            ys.append(CALL_INDEX[name])
        elif kind == "win":
            if label.get("kind") == "tsumo":
                tiles, globals_ = row_tensor(row)
                xs.append((tiles, globals_))
                ys.append(1)
            elif meta.get("kind") == "response" and meta.get("ron"):
                name = label.get("kind")
                if name in ("ron", "pass"):
                    tiles, globals_ = row_tensor(row)
                    xs.append((tiles, globals_))
                    ys.append(1 if name == "ron" else 0)
        else:
            raise ValueError(kind)
    if not xs:
        return {"empty": True, "n": 0}
    tiles = torch.from_numpy(np.stack([x[0] for x in xs]))
    globals_ = torch.from_numpy(np.stack([x[1] for x in xs]))
    y = torch.tensor(ys, dtype=torch.long)
    out = {"empty": False, "n_len": len(xs), "tiles": tiles, "globals": globals_, "y": y,
           "y_np": np.asarray(ys, dtype=np.int64)}
    if kind == "discard":
        out["mask"] = torch.from_numpy(np.stack(masks))
        out["forced"] = np.asarray(extra, dtype=bool)
    elif kind == "riichi":
        out["tile"] = np.asarray(extra, dtype=np.int64)
    return out


class Block(nn.Module):
    def __init__(self, width: int):
        super().__init__()
        self.conv1 = nn.Conv1d(width, width, 3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm1d(width)
        self.conv2 = nn.Conv1d(width, width, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm1d(width)

    def forward(self, x):
        h = F.relu(self.bn1(self.conv1(x)))
        h = self.bn2(self.conv2(h))
        return F.relu(x + h)


class PolicyNet(nn.Module):
    def __init__(self, channels: int, globals_n: int, width: int, blocks: int):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv1d(channels, width, 3, padding=1, bias=False), nn.BatchNorm1d(width), nn.ReLU())
        self.blocks = nn.Sequential(*[Block(width) for _ in range(blocks)])
        self.head = nn.Sequential(nn.Linear(width * 34 + globals_n, 256), nn.ReLU(), nn.Dropout(0.1))
        self.discard = nn.Linear(256, 34)
        self.riichi = nn.Linear(256, 2)
        self.call = nn.Linear(256, 5)
        self.win = nn.Linear(256, 2)

    def forward(self, tiles, globals_):
        h = self.blocks(self.stem(tiles))
        h = torch.cat([h.flatten(1), globals_], dim=1)
        h = self.head(h)
        return self.discard(h), self.riichi(h), self.call(h), self.win(h)


def masked_accuracy(logits: torch.Tensor, y: torch.Tensor, mask: torch.Tensor) -> float:
    masked = logits.masked_fill(mask <= 0, -1e9)
    return float((masked.argmax(dim=1) == y).float().mean())


def predict_head(model, data, batch=1024):
    model.eval()
    outs = []
    with torch.no_grad():
        for start in range(0, data["n_len"], batch):
            end = start + batch
            tiles, globals_ = data["tiles"][start:end], data["globals"][start:end]
            d, r, c, w = model(tiles, globals_)
            outs.append((d.cpu(), r.cpu(), c.cpu(), w.cpu()))
    return tuple(torch.cat([o[i] for o in outs], dim=0) for i in range(4))


def metrics(model, train, val) -> dict:
    result = {}
    if not val["discard"]["empty"]:
        d = val["discard"]
        logits, _, _, _ = predict_head(model, d)
        result["discard"] = {
            "n": int(d["n_len"]),
            "top1": float((logits.argmax(dim=1) == d["y"]).float().mean()),
            "top1Masked": masked_accuracy(logits, d["y"], d["mask"]),
            "forcedRate": float(d["forced"].mean()),
        }
    if not val["riichi"]["empty"]:
        r = val["riichi"]
        _, logits, _, _ = predict_head(model, r)
        pred = logits.argmax(dim=1)
        result["riichi"] = {"n": int(r["n_len"]), "positiveRate": float(r["y"].float().mean()),
                            "accuracy": float((pred == r["y"]).float().mean())}
    if not val["call"]["empty"]:
        c = val["call"]
        _, _, logits, _ = predict_head(model, c)
        pred = logits.argmax(dim=1)
        confusion = np.zeros((5, 5), dtype=np.int64)
        for t, p in zip(c["y_np"], pred.numpy()):
            confusion[int(t), int(p)] += 1
        per_class = {}
        for i, name in enumerate(CALL_NAMES):
            total = int(confusion[i].sum())
            per_class[name] = {"n": total, "recall": float(confusion[i, i] / total) if total else 0.0}
        result["call"] = {"n": int(c["n_len"]), "accuracy": float((pred == c["y"]).float().mean()),
                          "perClass": per_class, "confusion": confusion.tolist()}
    if not val["win"]["empty"]:
        w = val["win"]
        _, _, _, logits = predict_head(model, w)
        result["win"] = {"n": int(w["n_len"]), "positiveRate": float(w["y"].float().mean()),
                         "accuracy": float((logits.argmax(dim=1) == w["y"]).float().mean())}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="policy JSONL")
    parser.add_argument("--out-dir", default="test-results/policy-model")
    parser.add_argument("--width", type=int, default=128)
    parser.add_argument("--blocks", type=int, default=10)
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=20261123)
    parser.add_argument("--max-discard", type=int, default=0)
    parser.add_argument("--quick", action="store_true", help="4 blocks / 64 channels / 2 epochs")
    args = parser.parse_args()
    if args.quick:
        args.width, args.blocks, args.epochs = 64, 4, 2
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))
    rows = read_rows(args.data, args.max_discard)
    if not rows:
        raise SystemExit("no rows")
    train_rows, val_rows = split_rows(rows, args.val_fraction, args.seed)
    heads = {}
    for kind in ("discard", "riichi", "call", "win"):
        heads[kind] = {"train": build_head(train_rows, kind), "val": build_head(val_rows, kind)}
    channels = int(rows[0]["shape"]["channels"])
    globals_n = int(rows[0]["shape"]["globals"])
    model = PolicyNet(channels, globals_n, args.width, args.blocks)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    print(f"rows {len(rows)} train {len(train_rows)} val {len(val_rows)} | width {args.width} blocks {args.blocks}")
    for kind, data in heads.items():
        print(f"  {kind}: train {data['train'].get('n_len', 0)} val {data['val'].get('n_len', 0)}")
    losses = {"discard": 1.0, "riichi": 0.5, "call": 1.0, "win": 0.2}
    class_weights = {}
    for kind, n_classes in (("riichi", 2), ("call", 5), ("win", 2)):
        y = heads[kind]["train"].get("y_np")
        if y is None or not len(y):
            continue
        counts = np.bincount(y, minlength=n_classes).astype(np.float64)
        weight = counts.sum() / (n_classes * np.maximum(counts, 1.0))
        weight = np.clip(weight, 0.2, 12.0)
        class_weights[kind] = torch.tensor(weight, dtype=torch.float32)
        print(f"  {kind} class weights: {np.round(weight, 2).tolist()}")
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = {kind: np.random.permutation(heads[kind]["train"].get("n_len", 0)) for kind in heads}
        steps = max(1, math.ceil(max(heads[kind]["train"].get("n_len", 0) for kind in heads) / args.batch_size))
        total = Counter()
        for _ in range(steps):
            opt.zero_grad()
            loss = torch.zeros(())
            for kind, data in heads.items():
                train = data["train"]
                if train.get("empty") or train["n_len"] == 0:
                    continue
                idx = order[kind][: args.batch_size]
                order[kind] = np.roll(order[kind], -len(idx))
                tiles, globals_ = train["tiles"][idx], train["globals"][idx]
                d, r, c, w = model(tiles, globals_)
                if kind == "discard":
                    ce = F.cross_entropy(d, train["y"][idx])
                elif kind == "riichi":
                    ce = F.cross_entropy(r, train["y"][idx], weight=class_weights.get(kind))
                elif kind == "call":
                    ce = F.cross_entropy(c, train["y"][idx], weight=class_weights.get(kind))
                else:
                    ce = F.cross_entropy(w, train["y"][idx], weight=class_weights.get(kind))
                loss = loss + losses[kind] * ce
                total[kind] += float(ce)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
        avg = {k: (v / steps) for k, v in total.items()}
        print(f"epoch {epoch}: " + " ".join(f"{k} {v:.4f}" for k, v in avg.items()))
    result = {"width": args.width, "blocks": args.blocks, "channels": channels, "globals": globals_n,
              "featureVersion": FEATURE_VERSION,
              "trainRows": len(train_rows), "valRows": len(val_rows), "epochs": args.epochs,
              "heads": {kind: {"train": heads[kind]["train"].get("n_len", 0), "val": heads[kind]["val"].get("n_len", 0)} for kind in heads}}
    result["metrics"] = metrics(model, {k: v["train"] for k, v in heads.items()}, {k: v["val"] for k, v in heads.items()})
    result["classWeights"] = {k: v.tolist() for k, v in class_weights.items()}
    os.makedirs(args.out_dir, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(args.out_dir, "policy.pt"))
    with open(os.path.join(args.out_dir, "policy.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")
    model.eval()
    tiles = torch.zeros(1, channels, 34)
    globals_ = torch.zeros(1, globals_n)
    onnx_path = os.path.join(args.out_dir, "policy.onnx")
    torch.onnx.export(model, (tiles, globals_), onnx_path, opset_version=17,
                      input_names=["tiles", "globals"], output_names=["discard", "riichi", "call", "win"],
                      dynamic_axes={"tiles": {0: "batch"}, "globals": {0: "batch"},
                                    "discard": {0: "batch"}, "riichi": {0: "batch"},
                                    "call": {0: "batch"}, "win": {0: "batch"}},
                      dynamo=False)
    try:
        import onnx
        import onnxruntime as ort
        onnx.checker.check_model(onnx.load(onnx_path))
        session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        sample = rows[0]
        x = np.asarray(sample["x"], dtype=np.float32)
        t = x[:channels * 34].reshape(1, channels, 34)
        g = x[channels * 34:channels * 34 + globals_n].reshape(1, globals_n)
        with torch.no_grad():
            expected = model(torch.from_numpy(t), torch.from_numpy(g))
        got = session.run(None, {"tiles": t, "globals": g})
        diff = max(float(np.abs(e.numpy() - o).max()) for e, o in zip(expected, got))
        print(f"onnx check: max |torch - onnx| = {diff:.2e}")
        result["onnxMaxDiff"] = diff
    except Exception as error:  # noqa: BLE001
        print("onnx check skipped:", error)
    with open(os.path.join(args.out_dir, "policy.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")
    print(json.dumps(result["metrics"], indent=2))
    print("wrote", os.path.join(args.out_dir, "policy.onnx"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
