#!/usr/bin/env python3
"""Train the Game Result Prediction (GRP) MLP and export JSON + ONNX.

The input is the JSONL produced by tools/grp-dataset.js:

  {"v":"grp-v2","x":[...17 floats...],"rank":1..4,...}

The model estimates P(final placement | current standings). Only NumPy is
required for training; ONNX export additionally needs the `onnx` package.

  python tools/grp/train_grp.py --train data/grp-train.jsonl --val data/grp-val.jsonl --out-dir models
  python tools/grp/train_grp.py --selftest

The JSON model is consumed by src/grp.js / MJ.rank.setRankModel(). The ONNX
model uses the same MatMul -> Add -> ReLU stack and a final Softmax.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import sys
import tempfile
from dataclasses import dataclass

import numpy as np

FEATURES = [
    "score0", "score1", "score2", "score3",
    "diff0", "diff1", "diff2", "diff3",
    "honba", "riichi_sticks", "hands_left", "round_progress", "dealer",
    "seat0", "seat1", "seat2", "seat3",
]
VERSION = "grp-v2"


UMA = np.asarray([90.0, 45.0, 0.0, -135.0])  # Tenhou-style rank points


@dataclass
class Sample:
    x: np.ndarray
    rank: int
    source: str = ""
    match: str = ""
    hand: int = 0
    hand_index: int = 0


def read_jsonl(paths: list[str]) -> list[Sample]:
    rows: list[Sample] = []
    legacy = 0
    for path in paths:
        with open(path, "r", encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, 1):
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                version = row.get("v", VERSION)
                if version != VERSION:
                    legacy += 1
                    continue
                x = row.get("x")
                rank = row.get("rank")
                if not isinstance(x, list) or len(x) != len(FEATURES):
                    raise ValueError(f"{path}:{line_no}: x must have {len(FEATURES)} values")
                if not isinstance(rank, int) or not 1 <= rank <= 4:
                    raise ValueError(f"{path}:{line_no}: rank must be 1..4")
                match = str(row.get("match") or f"{path}:{line_no}")
                # `hand` is the unique hand ordinal inside a match (dealer repeats
                # reuse handIndex), while handIndex is the East/South round 0..7.
                hand = int(row.get("hand", row.get("handIndex", 0)) or 0)
                hand_index = int(row.get("handIndex", hand) or 0)
                rows.append(Sample(np.asarray(x, dtype=np.float64), rank - 1, path, match, hand, hand_index))
    if legacy:
        print(f"warning: skipped {legacy} GRP rows with version != {VERSION}; regenerate old shards", file=sys.stderr)
    if not rows:
        raise ValueError("no GRP samples found")
    return rows


def split_rows(rows: list[Sample], val_fraction: float, seed: int) -> tuple[list[Sample], list[Sample]]:
    """Split by match (all hands of a game stay together).

    Near-duplicate positions from the same half-game would otherwise leak into
    validation and inflate the metrics. Rows without a match id fall back to
    one-row groups.
    """
    groups: dict[str, list[Sample]] = {}
    for row in rows:
        groups.setdefault(row.match or f"row:{len(groups)}", []).append(row)
    keys = list(groups)
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(keys))
    target = max(1, int(round(len(rows) * val_fraction)))
    if target >= len(rows):
        target = max(1, len(rows) // 5)
    val_keys, val_count = set(), 0
    for index in order:
        if val_count >= target and val_keys:
            break
        key = keys[int(index)]
        val_keys.add(key)
        val_count += len(groups[key])
    train = [row for key in keys if key not in val_keys for row in groups[key]]
    val = [row for key in keys if key in val_keys for row in groups[key]]
    if not train or not val:
        cutoff = max(1, min(len(rows) - 1, int(round(len(rows) * val_fraction))))
        return rows[:cutoff], rows[cutoff:] or rows[-1:]
    return train, val


def dataset_checks(rows: list[Sample], train_rows: list[Sample], val_rows: list[Sample]) -> dict:
    """Detect duplicate samples and match leakage across the split."""
    keys, duplicates = set(), 0
    for row in rows:
        seat = int(np.argmax(row.x[13:17]))
        key = (row.match, row.hand, seat)
        if key in keys:
            duplicates += 1
        keys.add(key)
    train_matches = {row.match for row in train_rows}
    val_matches = {row.match for row in val_rows}
    overlap = train_matches & val_matches
    if overlap:
        raise ValueError(f"train/val match overlap: {len(overlap)} matches (e.g. {sorted(overlap)[:3]})")
    return {"samples": len(rows), "matches": len({row.match for row in rows}),
            "duplicateSampleKeys": duplicates, "trainValMatchOverlap": len(overlap),
            "trainMatches": len(train_matches), "valMatches": len(val_matches)}


def stack(rows: list[Sample]) -> tuple[np.ndarray, np.ndarray]:
    return np.stack([r.x for r in rows]), np.asarray([r.rank for r in rows], dtype=np.int64)


def softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(shifted)
    return exp / exp.sum(axis=1, keepdims=True)


def cross_entropy(prob: np.ndarray, y: np.ndarray) -> float:
    picked = np.clip(prob[np.arange(len(y)), y], 1e-12, 1.0)
    return float(-np.log(picked).mean())


def accuracy(prob: np.ndarray, y: np.ndarray) -> float:
    return float((prob.argmax(axis=1) == y).mean())


def brier(prob: np.ndarray, y: np.ndarray) -> float:
    target = np.zeros_like(prob)
    target[np.arange(len(y)), y] = 1.0
    return float(((prob - target) ** 2).sum(axis=1).mean())


PERMUTATIONS = list(itertools.permutations(range(4)))


def joint_from_rows(rows: np.ndarray) -> np.ndarray:
    """Project independent seat rows onto the 24 finishing orders.

    score(perm) = product_seat rows[seat, perm[seat]], normalised in log space.
    The resulting 4x4 matrix has row and column sums of exactly one.
    """
    rows = np.clip(np.asarray(rows, dtype=np.float64), 1e-12, None)
    logs = np.asarray([sum(math.log(rows[seat, perm[seat]]) for seat in range(4))
                       for perm in PERMUTATIONS])
    weights = np.exp(logs - logs.max())
    weights /= weights.sum()
    out = np.zeros((4, 4), dtype=np.float64)
    for perm, weight in zip(PERMUTATIONS, weights):
        for seat in range(4):
            out[seat, perm[seat]] += weight
    return out


def expected_rank_points(prob: np.ndarray) -> float:
    return float(prob @ UMA)


def baseline_rank(row: Sample) -> int:
    """Current-score order, with the lower seat index winning ties."""
    scores = row.x[:4] * 1000.0
    seat = int(np.argmax(row.x[13:17]))
    return 1 + int(sum(1 for other in range(4) if other != seat and
                       (scores[other] > scores[seat] or (scores[other] == scores[seat] and other < seat))))


def evaluate_joint(model: MLP, rows: list[Sample], mean: np.ndarray, std: np.ndarray) -> dict:
    """Score the 4x4 joint matrix per hand index, against the score-order baseline."""
    groups: dict[tuple[str, int], list[Sample]] = {}
    for row in rows:
        groups.setdefault((row.match, row.hand), []).append(row)
    buckets: dict[int, list[dict]] = {}
    consistency = 0.0
    for group in groups.values():
        if len(group) != 4 or sorted(int(np.argmax(g.x[13:17])) for g in group) != [0, 1, 2, 3]:
            continue
        group = sorted(group, key=lambda g: int(np.argmax(g.x[13:17])))
        x = np.stack([g.x for g in group])
        prob = model.predict((x - mean) / std)
        prob = joint_from_rows(prob)
        consistency = max(consistency, float(np.abs(prob.sum(axis=1) - 1).max()),
                          float(np.abs(prob.sum(axis=0) - 1).max()))
        for seat, row in enumerate(group):
            p = prob[seat]
            pred = int(np.argmax(p))
            actual_points = float(UMA[row.rank])
            base = baseline_rank(row)
            bucket = buckets.setdefault(row.hand_index, [])
            bucket.append({
                "loss": float(-math.log(max(1e-12, float(p[row.rank])))),
                "hit": 1.0 if pred == row.rank else 0.0,
                "first": 1.0 if (pred == 0 and row.rank == 0) else 0.0,
                "firstOpportunity": 1.0 if row.rank == 0 else 0.0,
                "mae": abs(expected_rank_points(p) - actual_points),
                "baseHit": 1.0 if base == row.rank + 1 else 0.0,
                "baseMae": abs(float(UMA[base - 1]) - actual_points),
            })
    def summarise(items: list[dict]) -> dict:
        if not items:
            return {"samples": 0}
        first_opportunities = sum(i["firstOpportunity"] for i in items)
        return {
            "samples": len(items),
            "logloss": float(np.mean([i["loss"] for i in items])),
            "top1": float(np.mean([i["hit"] for i in items])),
            "firstPlaceHit": float(sum(i["first"] for i in items) / first_opportunities) if first_opportunities else 0.0,
            "expectedRankPointsMae": float(np.mean([i["mae"] for i in items])),
            "baselineTop1": float(np.mean([i["baseHit"] for i in items])),
            "baselineExpectedRankPointsMae": float(np.mean([i["baseMae"] for i in items])),
        }
    per_round = {str(hand): summarise(items) for hand, items in sorted(buckets.items())}
    overall = summarise([item for items in buckets.values() for item in items])
    overall["matrixConsistency"] = consistency
    return {"overall": overall, "perRound": per_round}


class MLP:
    def __init__(self, sizes: list[int], seed: int):
        rng = np.random.default_rng(seed)
        self.sizes = sizes
        self.weights: list[np.ndarray] = []
        self.biases: list[np.ndarray] = []
        for n_in, n_out in zip(sizes[:-1], sizes[1:]):
            # He initialisation for the ReLU hidden layers.
            scale = math.sqrt(2.0 / max(1, n_in))
            self.weights.append(rng.normal(0.0, scale, size=(n_in, n_out)))
            self.biases.append(np.zeros(n_out))

    def forward(self, x: np.ndarray, cache: bool = False):
        activations = [x]
        pre = []
        a = x
        for i, (w, b) in enumerate(zip(self.weights, self.biases)):
            z = a @ w + b
            pre.append(z)
            a = np.maximum(z, 0.0) if i < len(self.weights) - 1 else z
            activations.append(a)
        prob = softmax(a)
        return (prob, activations, pre) if cache else prob

    def predict(self, x: np.ndarray) -> np.ndarray:
        return self.forward(x)


def train(model: MLP, train_rows: list[Sample], val_rows: list[Sample], mean: np.ndarray, std: np.ndarray,
          args) -> dict:
    x_train, y_train = stack(train_rows)
    x_val, y_val = stack(val_rows)
    x_train = (x_train - mean) / std
    x_val = (x_val - mean) / std
    n = len(y_train)
    rng = np.random.default_rng(args.seed + 1)
    # Adam state.
    m_w = [np.zeros_like(w) for w in model.weights]
    v_w = [np.zeros_like(w) for w in model.weights]
    m_b = [np.zeros_like(b) for b in model.biases]
    v_b = [np.zeros_like(b) for b in model.biases]
    step = 0
    best = {"loss": float("inf"), "epoch": 0, "weights": None, "biases": None}
    history = []
    patience = 0
    for epoch in range(1, args.epochs + 1):
        order = rng.permutation(n)
        for start in range(0, n, args.batch_size):
            idx = order[start:start + args.batch_size]
            xb, yb = x_train[idx], y_train[idx]
            prob, activations, pre = model.forward(xb, cache=True)
            # dL/dlogits for mean cross-entropy.
            delta = prob.copy()
            delta[np.arange(len(yb)), yb] -= 1.0
            delta /= len(yb)
            grad_w = [None] * len(model.weights)
            grad_b = [None] * len(model.biases)
            for layer in range(len(model.weights) - 1, -1, -1):
                grad_w[layer] = activations[layer].T @ delta + args.weight_decay * model.weights[layer]
                grad_b[layer] = delta.sum(axis=0)
                if layer > 0:
                    delta = (delta @ model.weights[layer].T) * (pre[layer - 1] > 0)
            step += 1
            lr = args.lr * (0.5 ** (epoch / max(1, args.epochs // 3)))
            beta1, beta2 = 0.9, 0.999
            for layer in range(len(model.weights)):
                m_w[layer] = beta1 * m_w[layer] + (1 - beta1) * grad_w[layer]
                v_w[layer] = beta2 * v_w[layer] + (1 - beta2) * (grad_w[layer] ** 2)
                m_b[layer] = beta1 * m_b[layer] + (1 - beta1) * grad_b[layer]
                v_b[layer] = beta2 * v_b[layer] + (1 - beta2) * (grad_b[layer] ** 2)
                mhat = m_w[layer] / (1 - beta1 ** step)
                vhat = v_w[layer] / (1 - beta2 ** step)
                model.weights[layer] -= lr * mhat / (np.sqrt(vhat) + 1e-8)
                mhat_b = m_b[layer] / (1 - beta1 ** step)
                vhat_b = v_b[layer] / (1 - beta2 ** step)
                model.biases[layer] -= lr * mhat_b / (np.sqrt(vhat_b) + 1e-8)
        train_prob = model.predict(x_train)
        val_prob = model.predict(x_val)
        train_loss = cross_entropy(train_prob, y_train)
        val_loss = cross_entropy(val_prob, y_val)
        history.append({"epoch": epoch, "trainLoss": train_loss, "valLoss": val_loss,
                        "trainAccuracy": accuracy(train_prob, y_train), "valAccuracy": accuracy(val_prob, y_val)})
        if val_loss < best["loss"] - 1e-6:
            best = {"loss": val_loss, "epoch": epoch,
                    "weights": [w.copy() for w in model.weights], "biases": [b.copy() for b in model.biases]}
            patience = 0
        else:
            patience += 1
            if patience >= args.patience:
                break
    model.weights = best["weights"]
    model.biases = best["biases"]
    val_prob = model.predict(x_val)
    train_prob = model.predict(x_train)
    majority = np.bincount(y_val, minlength=4).max() / len(y_val)
    joint = evaluate_joint(model, val_rows, mean, std)
    dataset = dataset_checks(train_rows + val_rows, train_rows, val_rows)
    return {
        "bestEpoch": best["epoch"],
        "epochs": len(history),
        "train": {"samples": int(len(y_train)), "loss": cross_entropy(train_prob, y_train),
                  "accuracy": accuracy(train_prob, y_train), "brier": brier(train_prob, y_train)},
        "val": {"samples": int(len(y_val)), "loss": cross_entropy(val_prob, y_val),
                "accuracy": accuracy(val_prob, y_val), "brier": brier(val_prob, y_val),
                "majorityBaseline": float(majority)},
        "joint": joint,
        "dataset": dataset,
        "rankDistribution": np.bincount(y_val, minlength=4).tolist(),
        "history": history,
    }


def export_onnx(model: MLP, mean: np.ndarray, std: np.ndarray, path: str) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    nodes = []
    inputs = [helper.make_tensor_value_info("features", TensorProto.FLOAT, [None, len(FEATURES)])]
    # Apply standardisation inside the graph so callers can pass raw features.
    mean_init = numpy_helper.from_array(mean.astype(np.float32).reshape(1, -1), "feature_mean")
    std_init = numpy_helper.from_array(std.astype(np.float32).reshape(1, -1), "feature_std")
    nodes.append(helper.make_node("Sub", ["features", "feature_mean"], ["centered"], name="standardize_sub"))
    nodes.append(helper.make_node("Div", ["centered", "feature_std"], ["normalized"], name="standardize_div"))
    current = "normalized"
    for layer, (w, b) in enumerate(zip(model.weights, model.biases)):
        w_init = numpy_helper.from_array(w.astype(np.float32), f"W{layer}")
        b_init = numpy_helper.from_array(b.astype(np.float32), f"B{layer}")
        nodes.append(helper.make_node("MatMul", [current, f"W{layer}"], [f"matmul{layer}"], name=f"matmul{layer}"))
        nodes.append(helper.make_node("Add", [f"matmul{layer}", f"B{layer}"], [f"add{layer}"], name=f"add{layer}"))
        current = f"add{layer}"
        if layer < len(model.weights) - 1:
            nodes.append(helper.make_node("Relu", [current], [f"relu{layer}"], name=f"relu{layer}"))
            current = f"relu{layer}"
    nodes.append(helper.make_node("Softmax", [current], ["probabilities"], name="softmax", axis=1))
    graph = helper.make_graph(
        nodes, "suitaku_grp",
        inputs,
        [helper.make_tensor_value_info("probabilities", TensorProto.FLOAT, [None, 4])],
        initializer=[mean_init, std_init] + [
            numpy_helper.from_array(w.astype(np.float32), f"W{i}") for i, w in enumerate(model.weights)
        ] + [numpy_helper.from_array(b.astype(np.float32), f"B{i}") for i, b in enumerate(model.biases)],
    )
    onnx_model = helper.make_model(graph, producer_name="suitaku-grp", opset_imports=[helper.make_opsetid("", 17)])
    onnx_model.ir_version = 8
    onnx.checker.check_model(onnx_model)
    onnx.save(onnx_model, path)


def check_onnx(model: MLP, mean: np.ndarray, std: np.ndarray, rows: list[Sample], path: str) -> None:
    import onnx
    try:
        from onnx.reference import ReferenceEvaluator
    except ImportError:
        print("warning: onnx.reference is unavailable; skipped numeric ONNX check", file=sys.stderr)
        return
    onnx.checker.check_model(onnx.load(path))
    x = np.stack([r.x for r in rows[:8]]).astype(np.float32)
    expected = model.predict((x - mean) / std)
    got = ReferenceEvaluator(path).run(None, {"features": x})[0]
    diff = float(np.abs(expected - got).max())
    print(f"onnx check: max |json - onnx| = {diff:.2e}")
    if diff > 1e-5:
        raise RuntimeError("ONNX export does not match the NumPy model")


def selftest(args) -> int:
    rng = np.random.default_rng(args.seed)
    rows = []
    # A simple hidden relationship: a large score advantage raises the chance of
    # first place. This only exercises the pipeline, not mahjong strength.
    for game in range(max(1, args.selftest_samples // 4)):
        scores = sorted(rng.normal(25000, 9000, size=4), reverse=True)
        rng.shuffle(scores)
        match = f"selftest-{game}"
        for seat in range(4):
            rank = 1 + sum(1 for s in scores if s > scores[seat])
            x = [scores[s] / 1000 for s in range(4)] + [(scores[seat] - scores[s]) / 1000 for s in range(4)]
            x += [0, 0, 4 / 8, 0, 0] + [1 if seat == s else 0 for s in range(4)]
            rows.append(Sample(np.asarray(x, dtype=np.float64), rank - 1, match=match, hand=0))
    train_rows, val_rows = split_rows(rows, 0.2, args.seed)
    with tempfile.TemporaryDirectory() as tmp:
        return _run(train_rows, val_rows, args, tmp)


def _run(train_rows: list[Sample], val_rows: list[Sample], args, out_dir: str) -> int:
    x_train, _ = stack(train_rows)
    mean = x_train.mean(axis=0)
    std = x_train.std(axis=0)
    std[std < 1e-6] = 1.0
    sizes = [len(FEATURES)] + [int(h) for h in args.hidden.split(",") if h.strip()] + [4]
    model = MLP(sizes, args.seed)
    metrics = train(model, train_rows, val_rows, mean, std, args)
    os.makedirs(out_dir, exist_ok=True)
    model_json = {
        "format": "suitaku-grp-model",
        "version": VERSION,
        "features": FEATURES,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "activation": "relu",
        "output": "softmax",
        "layers": [{"w": w.tolist(), "b": b.tolist()} for w, b in zip(model.weights, model.biases)],
        "metrics": {k: v for k, v in metrics.items() if k != "history"},
        "training": {"epochs": metrics["epochs"], "bestEpoch": metrics["bestEpoch"], "hidden": sizes[1:-1],
                     "batchSize": args.batch_size, "learningRate": args.lr, "weightDecay": args.weight_decay,
                     "seed": args.seed, "splitBy": "match", "trainSamples": len(train_rows), "valSamples": len(val_rows)},
        "note": "P(final rank | standings). Trained on self-play or converted logs; not a calibrated win probability."
    }
    json_path = os.path.join(out_dir, "grp.json")
    with open(json_path, "w", encoding="utf-8") as handle:
        json.dump(model_json, handle, indent=2)
        handle.write("\n")
    onnx_path = None
    if not args.no_onnx:
        onnx_path = os.path.join(out_dir, "grp.onnx")
        try:
            export_onnx(model, mean, std, onnx_path)
            check_onnx(model, mean, std, val_rows, onnx_path)
        except ImportError:
            print("warning: onnx is not installed; skipped ONNX export", file=sys.stderr)
            onnx_path = None
    print(f"train samples {len(train_rows)} / val {len(val_rows)} (split by match; "
          f"matches {metrics['dataset']['trainMatches']}/{metrics['dataset']['valMatches']}, "
          f"overlap {metrics['dataset']['trainValMatchOverlap']}, "
          f"duplicate keys {metrics['dataset']['duplicateSampleKeys']})")
    print(f"val accuracy {metrics['val']['accuracy']:.4f} (majority {metrics['val']['majorityBaseline']:.4f}) "
          f"/ logloss {metrics['val']['loss']:.4f} / brier {metrics['val']['brier']:.4f}")
    joint = metrics.get("joint") or {}
    overall = joint.get("overall") or {}
    if overall.get("samples"):
        print(f"joint 4x4 (24 permutations): top1 {overall['top1']:.4f} (score-order {overall['baselineTop1']:.4f}) "
              f"/ logloss {overall['logloss']:.4f} / rank-point MAE {overall['expectedRankPointsMae']:.3f} "
              f"(score-order {overall['baselineExpectedRankPointsMae']:.3f}) "
              f"/ matrix max row-col error {overall['matrixConsistency']:.2e}")
        names = ["E1", "E2", "E3", "E4", "S1", "S2", "S3", "S4"]
        for key, values in (joint.get("perRound") or {}).items():
            if not values.get("samples"):
                continue
            label = names[int(key)] if int(key) < len(names) else f"hand {key}"
            print(f"  {label}: n={values['samples']} top1 {values['top1']:.3f} "
                  f"first {values['firstPlaceHit']:.3f} logloss {values['logloss']:.3f} "
                  f"rankMAE {values['expectedRankPointsMae']:.2f} "
                  f"(score-order {values['baselineTop1']:.3f} / {values['baselineExpectedRankPointsMae']:.2f})")
    print(f"wrote {json_path}" + (f" and {onnx_path}" if onnx_path else ""))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train", nargs="*", default=[], help="training JSONL files")
    parser.add_argument("--val", nargs="*", default=[], help="validation JSONL files")
    parser.add_argument("--out-dir", default="models")
    parser.add_argument("--hidden", default="64,64")
    parser.add_argument("--epochs", type=int, default=300)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=0.01)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--patience", type=int, default=30)
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=20261022)
    parser.add_argument("--no-onnx", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--selftest-samples", type=int, default=2000)
    args = parser.parse_args()
    if args.selftest:
        return selftest(args)
    if not args.train:
        parser.error("--train is required unless --selftest is used")
    rows = read_jsonl(args.train + args.val)
    if args.val:
        train_rows = read_jsonl(args.train)
        val_rows = read_jsonl(args.val)
    else:
        train_rows, val_rows = split_rows(rows, args.val_fraction, args.seed)
    return _run(train_rows, val_rows, args, args.out_dir)


if __name__ == "__main__":
    sys.exit(main())
