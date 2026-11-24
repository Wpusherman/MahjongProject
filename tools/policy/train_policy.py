#!/usr/bin/env python3
"""Train the obs-v2 policy network and export ONNX.

Input is either the JSONL from ``tools/features.js`` / ``tools/policy-dataset.js``
or the Parquet shards from ``tools/to_parquet.py``. The network is a small Mortal-
style ResNet over the 34-tile axis with four heads:

  discard : 34 tiles
  riichi  : 2 classes (declare / dama) on can-riichi discard states
  call    : 5 classes (pass / chi / pon / kan / ron)
  win     : 2 classes (accept / decline) at tsumo or ron opportunities

Splitting is by match (never by row), and the default is 90/5/5 train/val/test
with a fixed seed. Illegal actions are masked both in the loss and at inference:
``src/policy.js`` rebuilds the same mask from the public observation.

Examples:
  # smoke test: does the loader, splitter and mask wiring work without torch?
  python tools/policy/train_policy.py --data data/parquet --check-data

  # step 2(a): overfit 100 discard samples (must reach ~100% accuracy)
  python tools/policy/train_policy.py --data small.jsonl --overfit 100 --quick

  # step 3: full training + ONNX export
  python tools/policy/train_policy.py --data data/parquet --out-dir test-results/policy-model

Parquet rows written by feature-parquet-v1 lack ``match`` and ``label``; they
still load (match falls back to the shard name) and a warning is printed.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
from collections import Counter, defaultdict

import numpy as np

try:  # torch is only needed for training/export; --check-data works without it.
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError:  # pragma: no cover - exercised by environments without torch
    torch = nn = F = None

CALL_NAMES = ["pass", "chi", "pon", "kan", "ron"]
CALL_INDEX = {name: i for i, name in enumerate(CALL_NAMES)}
CALL_KINDS = set(CALL_NAMES)
FEATURE_VERSION = "obs-v2"
MODEL_VERSION = "policy-v1"


# --------------------------------------------------------------------------- #
# Data loading
# --------------------------------------------------------------------------- #
def expand_inputs(items: list[str]) -> list[str]:
    """Expand file globs and directories. Directories yield .parquet/.jsonl."""
    paths: list[str] = []
    for item in items:
        matches = glob.glob(item)
        if not matches:
            matches = [item]
        for path in matches:
            if os.path.isdir(path):
                paths.extend(sorted(glob.glob(os.path.join(path, "*.parquet"))))
                paths.extend(sorted(glob.glob(os.path.join(path, "*.jsonl"))))
            else:
                paths.append(path)
    for path in paths:
        if not os.path.exists(path):
            raise SystemExit(f"input not found: {path}")
    if not paths:
        raise SystemExit("no input files matched")
    return paths


def _row_from_jsonl(line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    return json.loads(line)


def _prepare_row(row: dict) -> dict:
    """Normalise a raw row and store the tensor as float32 (not a Python list)."""
    shape = row.get("shape") or {}
    meta = row.get("meta") or {}
    row["shape"] = {"channels": int(shape.get("channels") or 0),
                    "tiles": int(shape.get("tiles") or 34),
                    "globals": int(shape.get("globals") or 0)}
    row["x"] = row.get("x")
    if not isinstance(row["x"], np.ndarray):
        row["x"] = np.asarray(row["x"] if row["x"] is not None else [], dtype=np.float32)
    row["label"] = row.get("label") or {}
    row["meta"] = meta
    row["match"] = str(row.get("match") or meta.get("match") or "match")
    return row


def _row_from_parquet(record: dict, path: str) -> tuple[dict, bool]:
    """Reconstruct the training row. Returns (row, has_match_column)."""
    shape = {"channels": int(record["channels"]), "tiles": int(record["tiles"]),
             "globals": int(record["globals"])}
    meta = json.loads(record["meta"]) if record.get("meta") else {}
    raw_label = record.get("label")
    if raw_label:
        label = json.loads(raw_label)
    else:  # feature-parquet-v1 fallback: rebuild a partial label from columns.
        label = {"kind": record.get("kind") or ""}
        if record.get("tile") is not None:
            label["tile"] = int(record["tile"])
        label["riichi"] = bool(record.get("riichi", False))
        label["tsumogiri"] = bool(record.get("tsumogiri", False))
        label["forced"] = bool(record.get("forced", False))
        if record.get("can_riichi") is not None:
            label["canRiichi"] = bool(record["can_riichi"])
    has_match = bool(record.get("match"))
    row = {
        "v": record.get("feature_version"),
        "match": record.get("match") or meta.get("match") or os.path.basename(path),
        "hand": record.get("hand"),
        "event": record.get("event"),
        "seat": record.get("seat"),
        "shape": shape,
        "x": np.asarray(record["x"], dtype=np.float32),
        "label": label,
        "meta": meta,
    }
    return row, has_match


def _iter_raw_rows(paths: list[str], stats: dict):
    for path in paths:
        if path.lower().endswith((".parquet", ".pq")):
            import pyarrow.parquet as pq  # lazy: JSONL training needs no pyarrow
            stats["parquet"] += 1
            for batch in pq.ParquetFile(path).iter_batches(batch_size=50000):
                for record in batch.to_pylist():
                    row, has_match = _row_from_parquet(record, path)
                    if not has_match:
                        stats["missingMatch"] += 1
                    yield row
        else:
            stats["jsonl"] += 1
            with open(path, "r", encoding="utf-8") as handle:
                for line in handle:
                    row = _row_from_jsonl(line)
                    if row is not None:
                        yield row


def read_rows(inputs: list[str], max_discard: int, max_rows: int = 0) -> tuple[list[dict], dict]:
    paths = expand_inputs(inputs)
    rows: list[dict] = []
    stats = {"files": len(paths), "parquet": 0, "jsonl": 0, "legacy": 0,
             "missingMatch": 0, "discardCapped": 0, "rowCapped": 0}
    discard_count = 0
    for raw in _iter_raw_rows(paths, stats):
        row = _prepare_row(raw)
        if row.get("v") != FEATURE_VERSION:
            stats["legacy"] += 1
            continue
        if row["shape"]["tiles"] != 34:
            raise ValueError("obs-v2 requires 34 tiles")
        label = row["label"]
        kind = label.get("kind")
        if kind == "discard":
            if max_discard and discard_count >= max_discard:
                stats["discardCapped"] += 1
                continue
            discard_count += 1
        row["_kind"] = kind
        rows.append(row)
        if max_rows and len(rows) >= max_rows:
            stats["rowCapped"] = 1
            break
    if stats["legacy"]:
        print(f"warning: skipped {stats['legacy']} rows with feature version != {FEATURE_VERSION}; "
              "regenerate old shards", file=sys.stderr)
    if stats["missingMatch"]:
        print(f"warning: {stats['missingMatch']} parquet rows have no match column; "
              "grouping falls back to the shard name (regenerate with feature-parquet-v2)",
              file=sys.stderr)
    if stats["rowCapped"]:
        print(f"warning: --max-rows {max_rows} reached; the remaining shards were not read",
              file=sys.stderr)
    if not rows:
        raise SystemExit(f"no {FEATURE_VERSION} policy rows found")
    return rows, stats


# --------------------------------------------------------------------------- #
# Split
# --------------------------------------------------------------------------- #
def split_rows(rows: list[dict], val_fraction: float, test_fraction: float, seed: int) -> dict:
    """Match-grouped train/val/test split with a fixed seed.

    Splitting by match keeps every hand of a game on one side, otherwise near-
    duplicate positions leak into validation. With fewer than three matches the
    requested fractions cannot all be honoured; the split degrades gracefully.
    """
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[str(row.get("match") or "match")].append(row)
    keys = sorted(groups)
    rng = np.random.default_rng(seed)
    order = [keys[int(i)] for i in rng.permutation(len(keys))]
    total = len(rows)
    n_val = max(0, int(round(total * val_fraction)))
    n_test = max(0, int(round(total * test_fraction)))
    if len(keys) >= 3:
        n_val = max(1, n_val)
        n_test = max(1, n_test)
    elif len(keys) == 2:
        n_val, n_test = max(1, n_val), 0
    else:
        n_val = n_test = 0

    def take(target: int) -> list[str]:
        chosen: list[str] = []
        count = 0
        while order and count < target:
            key = order.pop(0)
            chosen.append(key)
            count += len(groups[key])
        return chosen

    test_keys = take(n_test)
    val_keys = take(n_val)
    if not order and len(keys) > 1:  # keep at least one match for training
        if test_keys:
            order.append(test_keys.pop())
        elif val_keys:
            order.append(val_keys.pop())
    train_keys = order

    def collect(selected: list[str]) -> list[dict]:
        return [row for key in selected for row in groups[key]]

    for key in train_keys + val_keys + test_keys:
        for row in groups[key]:
            row["_split"] = "test" if key in test_keys else "val" if key in val_keys else "train"
    return {
        "train": collect(train_keys),
        "val": collect(val_keys),
        "test": collect(test_keys),
        "matches": {"train": len(train_keys), "val": len(val_keys), "test": len(test_keys)},
    }


# --------------------------------------------------------------------------- #
# Tensors and per-head datasets
# --------------------------------------------------------------------------- #
def row_tensor(row: dict) -> tuple[np.ndarray, np.ndarray]:
    x = np.asarray(row["x"], dtype=np.float32)
    shape = row["shape"]
    channels, tiles, globals_n = int(shape["channels"]), int(shape["tiles"]), int(shape["globals"])
    return x[:channels * tiles].reshape(channels, tiles), x[channels * tiles:channels * tiles + globals_n]


def discard_mask(tiles: np.ndarray, label: dict) -> np.ndarray:
    legal = label.get("legal")
    if isinstance(legal, list) and legal:
        mask = np.zeros(34, dtype=np.float32)
        for t in legal:
            if 0 <= int(t) < 34:
                mask[int(t)] = 1.0
    else:  # feature-parquet-v1 / older JSONL: hand channel is the legal set
        mask = (tiles[0] > 0).astype(np.float32)
    tile = label.get("tile")
    if isinstance(tile, int) and 0 <= tile < 34:
        mask[tile] = 1.0  # the recorded action is always legal
    return mask


def call_mask(label: dict, meta: dict, target: int) -> np.ndarray:
    mask = np.ones(5, dtype=np.float32)
    # Synthetic Tenhou responses carry the legal option flags. A real `response`
    # event without flags (older 翠卓 records) leaves every class legal.
    if meta.get("kind") == "response" and any(k in meta for k in ("ron", "pon", "kan", "chi")):
        mask[1] = 1.0 if meta.get("chi") else 0.0
        mask[2] = 1.0 if meta.get("pon") else 0.0
        mask[3] = 1.0 if meta.get("kan") else 0.0
        mask[4] = 1.0 if meta.get("ron") else 0.0
    mask[target] = 1.0
    return mask


def build_head(rows: list[dict], kind: str) -> dict:
    xs, ys, masks, extra = [], [], [], []
    skipped = Counter()
    for row in rows:
        label = row.get("label") or {}
        meta = row.get("meta") or {}
        if kind == "discard":
            if label.get("kind") != "discard":
                continue
            if label.get("forced"):  # riichi tsumogiri is not a decision
                skipped["forced"] += 1
                continue
            tiles, globals_ = row_tensor(row)
            mask = discard_mask(tiles, label)
            if float(mask.sum()) <= 0:
                skipped["noLegal"] += 1
                continue
            xs.append((tiles, globals_))
            ys.append(int(label.get("tile", 0)))
            masks.append(mask)
        elif kind == "riichi":
            if label.get("kind") != "discard" or not label.get("canRiichi"):
                continue
            tiles, globals_ = row_tensor(row)
            xs.append((tiles, globals_))
            ys.append(1 if label.get("riichi") else 0)
        elif kind == "call":
            if meta.get("kind") != "response" and label.get("kind") not in CALL_KINDS:
                continue
            name = label.get("kind")
            if name not in CALL_INDEX:
                continue
            target = CALL_INDEX[name]
            tiles, globals_ = row_tensor(row)
            xs.append((tiles, globals_))
            ys.append(target)
            masks.append(call_mask(label, meta, target))
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
        return {"empty": True, "n_len": 0, "skipped": dict(skipped)}
    tiles = torch.from_numpy(np.stack([x[0] for x in xs]))
    globals_ = torch.from_numpy(np.stack([x[1] for x in xs]))
    y = torch.tensor(ys, dtype=torch.long)
    out = {"empty": False, "n_len": len(xs), "tiles": tiles, "globals": globals_, "y": y,
           "y_np": np.asarray(ys, dtype=np.int64), "skipped": dict(skipped)}
    if kind == "discard":
        out["mask"] = torch.from_numpy(np.stack(masks))
    elif kind == "call":
        out["mask"] = torch.from_numpy(np.stack(masks))
    return out


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #
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
        self.stem = nn.Sequential(nn.Conv1d(channels, width, 3, padding=1, bias=False),
                                  nn.BatchNorm1d(width), nn.ReLU())
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


def masked_logits(logits: torch.Tensor, mask: torch.Tensor | None) -> torch.Tensor:
    if mask is None:
        return logits
    return logits.masked_fill(mask <= 0, -1e9)


def masked_cross_entropy(logits, y, mask=None, weight=None) -> torch.Tensor:
    return F.cross_entropy(masked_logits(logits, mask), y, weight=weight)


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


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
def _softmax_np(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def masked_accuracy(logits: torch.Tensor, y: torch.Tensor, mask: torch.Tensor) -> float:
    masked = masked_logits(logits, mask)
    return float((masked.argmax(dim=1) == y).float().mean())


def head_metrics(model, kind: str, data: dict) -> dict | None:
    if not data or data.get("empty"):
        return None
    logits = predict_head(model, data)[{"discard": 0, "riichi": 1, "call": 2, "win": 3}[kind]]
    pred = logits.argmax(dim=1)
    result: dict = {"n": int(data["n_len"]),
                    "accuracy": float((pred == data["y"]).float().mean())}
    if kind == "discard":
        mask = data["mask"]
        masked = masked_logits(logits, mask)
        probs = _softmax_np(logits.numpy())
        illegal = (mask.numpy() <= 0)
        # After masking, illegal probability is exactly zero. The unmasked mass
        # is reported so a regression in the loss is visible.
        result["top1Masked"] = float((masked.argmax(dim=1) == data["y"]).float().mean())
        result["top1"] = float((pred == data["y"]).float().mean())
        result["illegalMass"] = float((probs * illegal).sum(axis=1).mean()) if illegal.any() else 0.0
        masked_probs = _softmax_np(masked.numpy())
        result["maskedIllegalMass"] = float((masked_probs * illegal).sum(axis=1).mean()) if illegal.any() else 0.0
        result["maskOk"] = bool(result["maskedIllegalMass"] < 1e-6)
        result["meanLegal"] = float(mask.sum(dim=1).mean())
        if data.get("skipped"):
            result["skipped"] = data["skipped"]
    elif kind == "riichi":
        result["positiveRate"] = float(data["y"].float().mean())
        tp = int(((pred == 1) & (data["y"] == 1)).sum())
        pos = int((data["y"] == 1).sum())
        result["recallDeclare"] = float(tp / pos) if pos else 0.0
        if data.get("skipped"):
            result["skipped"] = data["skipped"]
    elif kind == "call":
        mask = data.get("mask")
        masked = masked_logits(logits, mask)
        result["accuracyMasked"] = float((masked.argmax(dim=1) == data["y"]).float().mean())
        confusion = np.zeros((5, 5), dtype=np.int64)
        for t, p in zip(data["y_np"], pred.numpy()):
            confusion[int(t), int(p)] += 1
        per_class = {}
        for i, name in enumerate(CALL_NAMES):
            total = int(confusion[i].sum())
            per_class[name] = {"n": total,
                               "recall": float(confusion[i, i] / total) if total else 0.0}
        result["perClass"] = per_class
        result["confusion"] = confusion.tolist()
        if data.get("skipped"):
            result["skipped"] = data["skipped"]
    elif kind == "win":
        result["positiveRate"] = float(data["y"].float().mean())
    return result


def split_metrics(model, heads: dict, split: str) -> dict:
    out = {}
    for kind in ("discard", "riichi", "call", "win"):
        value = head_metrics(model, kind, heads[kind].get(split))
        if value is not None:
            out[kind] = value
    return out


# --------------------------------------------------------------------------- #
# Training
# --------------------------------------------------------------------------- #
LOSS_WEIGHTS = {"discard": 1.0, "riichi": 0.5, "call": 1.0, "win": 0.2}


def class_weights_for(heads: dict) -> dict:
    weights = {}
    for kind, n_classes in (("riichi", 2), ("call", 5), ("win", 2)):
        y = heads[kind]["train"].get("y_np")
        if y is None or not len(y):
            continue
        counts = np.bincount(y, minlength=n_classes).astype(np.float64)
        weight = counts.sum() / (n_classes * np.maximum(counts, 1.0))
        weight = np.clip(weight, 0.2, 12.0)
        weights[kind] = torch.tensor(weight, dtype=torch.float32)
        print(f"  {kind} class weights: {np.round(weight, 2).tolist()}")
    return weights


def train_model(model, heads, class_weights, args) -> list[dict]:
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    history = []
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
                    ce = masked_cross_entropy(d, train["y"][idx], train["mask"][idx])
                elif kind == "riichi":
                    ce = masked_cross_entropy(r, train["y"][idx], weight=class_weights.get(kind))
                elif kind == "call":
                    ce = masked_cross_entropy(c, train["y"][idx], train.get("mask")[idx]
                                              if train.get("mask") is not None else None,
                                              weight=class_weights.get(kind))
                else:
                    ce = masked_cross_entropy(w, train["y"][idx], weight=class_weights.get(kind))
                loss = loss + LOSS_WEIGHTS[kind] * ce
                total[kind] += float(ce.detach())
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
        avg = {k: (v / steps) for k, v in total.items()}
        record = {"epoch": epoch, **{k: float(v) for k, v in avg.items()}}
        history.append(record)
        print(f"epoch {epoch}: " + " ".join(f"{k} {v:.4f}" for k, v in avg.items()))
    return history


def run_overfit(rows: list[dict], args, channels: int, globals_n: int) -> int:
    """Step 2(a): memorize N discard samples and assert near-perfect accuracy."""
    data = build_head(rows, "discard")
    if data.get("empty"):
        raise SystemExit("overfit: no discard samples")
    n = min(args.overfit, data["n_len"])
    subset = {key: (data[key][:n] if torch.is_tensor(data.get(key)) else data[key])
              for key in ("tiles", "globals", "y", "mask")}
    subset["n_len"] = n
    subset["empty"] = False
    model = PolicyNet(channels, globals_n, args.width, args.blocks)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.0)
    for epoch in range(1, args.epochs + 1):
        model.train()
        opt.zero_grad()
        d, _, _, _ = model(subset["tiles"], subset["globals"])
        loss = masked_cross_entropy(d, subset["y"], subset["mask"])
        loss.backward()
        opt.step()
        if epoch == 1 or epoch % max(1, args.epochs // 10) == 0:
            print(f"overfit epoch {epoch}: loss {float(loss):.4f}")
    result = head_metrics(model, "discard", subset)
    accuracy = result["top1Masked"]
    print(json.dumps({"overfit": n, "epochs": args.epochs, **result}, indent=2))
    if accuracy < args.overfit_threshold:
        print(f"OVERFIT FAIL: accuracy {accuracy:.4f} < {args.overfit_threshold}", file=sys.stderr)
        return 1
    print(f"OVERFIT OK: {accuracy:.4f} on {n} samples")
    return 0


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", nargs="+", required=True,
                        help="JSONL files / Parquet shards / directories")
    parser.add_argument("--out-dir", default="test-results/policy-model")
    parser.add_argument("--width", type=int, default=128)
    parser.add_argument("--blocks", type=int, default=10)
    parser.add_argument("--epochs", type=int, default=None,
                        help="training epochs (default: 6; 300 with --overfit)")
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--val-fraction", type=float, default=0.05)
    parser.add_argument("--test-fraction", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=20261123)
    parser.add_argument("--max-discard", type=int, default=0)
    parser.add_argument("--max-rows", type=int, default=0,
                        help="stop reading after N rows (caps memory for huge shards)")
    parser.add_argument("--quick", action="store_true", help="4 blocks / 64 channels / 2 epochs")
    parser.add_argument("--check-data", action="store_true",
                        help="load, split and report only (no torch required)")
    parser.add_argument("--overfit", type=int, default=0, metavar="N",
                        help="memorize N discard samples and exit (step 2a)")
    parser.add_argument("--overfit-threshold", type=float, default=0.99)
    args = parser.parse_args(argv)
    args.epochs = args.epochs if args.epochs is not None else (300 if args.overfit else 6)
    if args.quick:
        args.width, args.blocks = 64, 4
        if args.epochs == 6:
            args.epochs = 2

    rows, stats = read_rows(args.data, args.max_discard, args.max_rows)
    split = split_rows(rows, args.val_fraction, args.test_fraction, args.seed)
    channels = int(rows[0]["shape"]["channels"])
    globals_n = int(rows[0]["shape"]["globals"])

    if args.check_data:
        labels = Counter(row.get("_kind") for row in rows)
        report = {"format": "suitaku-policy-check", "featureVersion": FEATURE_VERSION,
                  "rows": len(rows), "input": stats, "matches": split["matches"],
                  "splitRows": {k: len(split[k]) for k in ("train", "val", "test")},
                  "labels": dict(labels), "channels": channels, "globals": globals_n,
                  "seed": args.seed, "valFraction": args.val_fraction, "testFraction": args.test_fraction}
        print(json.dumps(report, indent=2))
        return 0

    if torch is None:
        raise SystemExit("training requires torch: python -m pip install torch")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.set_num_threads(max(1, (os.cpu_count() or 2) - 1))

    if args.overfit:
        return run_overfit(rows, args, channels, globals_n)

    heads = {kind: {name: build_head(split[name], kind) for name in ("train", "val", "test")}
             for kind in ("discard", "riichi", "call", "win")}
    model = PolicyNet(channels, globals_n, args.width, args.blocks)
    print(f"rows {len(rows)} split {split['matches']} | width {args.width} blocks {args.blocks} epochs {args.epochs}")
    for kind, data in heads.items():
        print(f"  {kind}: " + " ".join(f"{name} {data[name].get('n_len', 0)}" for name in ("train", "val", "test")))
    class_weights = class_weights_for(heads)
    history = train_model(model, heads, class_weights, args)

    result = {
        "format": "suitaku-policy-model",
        "version": MODEL_VERSION,
        "featureVersion": FEATURE_VERSION,
        "width": args.width,
        "blocks": args.blocks,
        "channels": channels,
        "globals": globals_n,
        "epochs": args.epochs,
        "lr": args.lr,
        "batchSize": args.batch_size,
        "seed": args.seed,
        "lossWeights": LOSS_WEIGHTS,
        "split": {"matches": split["matches"], "rows": {k: len(split[k]) for k in ("train", "val", "test")}},
        "heads": {kind: {name: heads[kind][name].get("n_len", 0) for name in ("train", "val", "test")}
                  for kind in heads},
        "classWeights": {k: v.tolist() for k, v in class_weights.items()},
        "legalMask": "discard: label.legal (fallback hand channel); call: response options",
        "history": history,
        "metrics": {name: split_metrics(model, heads, name) for name in ("train", "val", "test")},
    }
    os.makedirs(args.out_dir, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(args.out_dir, "policy.pt"))
    with open(os.path.join(args.out_dir, "policy.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
        handle.write("\n")

    model.eval()
    sample = rows[0]
    x = np.asarray(sample["x"], dtype=np.float32)
    tiles = torch.zeros(1, channels, 34)
    globals_ = torch.zeros(1, globals_n)
    onnx_path = os.path.join(args.out_dir, "policy.onnx")
    torch.onnx.export(
        model, (tiles, globals_), onnx_path, opset_version=17,
        input_names=["tiles", "globals"], output_names=["discard", "riichi", "call", "win"],
        dynamic_axes={"tiles": {0: "batch"}, "globals": {0: "batch"},
                      "discard": {0: "batch"}, "riichi": {0: "batch"},
                      "call": {0: "batch"}, "win": {0: "batch"}},
        dynamo=False,
    )
    try:
        import onnx
        import onnxruntime as ort
        onnx.checker.check_model(onnx.load(onnx_path))
        session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
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
    print("wrote", onnx_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
