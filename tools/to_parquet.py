#!/usr/bin/env python3
"""Convert 翠卓 feature JSONL shards to Parquet.

  python tools/to_parquet.py features-*.jsonl --out data/parquet --shard-size 100000

The JSONL is the format produced by `node tools/features.js`. One row is one
decision sample. The flat tensor is kept as `list<float>` so the channel layout
stays explicit in the row; `schema_version`, `feature_version`, channel names
and global names are stored in the Parquet file metadata and in _metadata.json.

Requires: pyarrow.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError as exc:  # pragma: no cover - exercised by environments without pyarrow
    print("to_parquet requires pyarrow: python -m pip install pyarrow", file=sys.stderr)
    raise SystemExit(2) from exc

SCHEMA_VERSION = "features-parquet-v1"


def row_from(line: str, path: str, line_no: int) -> dict:
    row = json.loads(line)
    shape = row.get("shape") or {}
    channels = int(shape.get("channels") or 0)
    tiles = int(shape.get("tiles") or 34)
    globals_count = int(shape.get("globals") or 0)
    x = row.get("x")
    if not isinstance(x, list) or len(x) != channels * tiles + globals_count:
        raise ValueError(f"{path}:{line_no}: tensor length does not match shape")
    label = row.get("label") or {}
    meta = row.get("meta") or {}
    return {
        "schema_version": SCHEMA_VERSION,
        "feature_version": str(row.get("v") or meta.get("version") or ""),
        "hand": int(row.get("hand", meta.get("hand", -1))),
        "event": int(row.get("event", meta.get("eventIndex", -1))),
        "seat": int(row.get("seat", meta.get("seat", -1))),
        "kind": str(label.get("kind") or ""),
        "tile": int(label["tile"]) if isinstance(label.get("tile"), int) else None,
        "riichi": bool(label.get("riichi", False)),
        "tsumogiri": bool(label.get("tsumogiri", False)),
        "forced": bool(label.get("forced", False)),
        "channels": channels,
        "tiles": tiles,
        "globals": globals_count,
        "x": [float(v) for v in x],
        "channel_names": ",".join(row.get("channels") or []),
        "global_names": ",".join(row.get("globals") or []),
        "meta": json.dumps(meta, separators=(",", ":"), ensure_ascii=False),
    }


def schema_for(rows: list[dict]) -> pa.Schema:
    return pa.schema([
        ("schema_version", pa.string()),
        ("feature_version", pa.string()),
        ("hand", pa.int32()),
        ("event", pa.int32()),
        ("seat", pa.int8()),
        ("kind", pa.string()),
        ("tile", pa.int8()),
        ("riichi", pa.bool_()),
        ("tsumogiri", pa.bool_()),
        ("forced", pa.bool_()),
        ("channels", pa.int16()),
        ("tiles", pa.int16()),
        ("globals", pa.int16()),
        ("x", pa.list_(pa.float32())),
        ("channel_names", pa.string()),
        ("global_names", pa.string()),
        ("meta", pa.string()),
    ])


def write_shard(rows: list[dict], path: str, metadata: dict[str, str]) -> None:
    schema = schema_for(rows).with_metadata({k.encode("utf-8"): v.encode("utf-8") for k, v in metadata.items()})
    table = pa.Table.from_pylist(rows, schema=schema)
    pq.write_table(table, path, compression="zstd")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--shard-size", type=int, default=100000)
    parser.add_argument("--prefix", default="features")
    parser.add_argument("--schema-version", default=SCHEMA_VERSION,
                        help="override the recorded schema version (does not change columns)")
    args = parser.parse_args()
    if args.shard_size < 1:
        parser.error("--shard-size must be positive")
    os.makedirs(args.out, exist_ok=True)
    shards: list[dict] = []
    total = 0
    shard_index = 0
    feature_versions: set[str] = set()
    channel_names: set[str] = set()
    global_names: set[str] = set()
    files = []
    for path in args.inputs:
        with open(path, "r", encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, 1):
                line = line.strip()
                if not line:
                    continue
                row = row_from(line, path, line_no)
                row["schema_version"] = args.schema_version
                feature_versions.add(row["feature_version"])
                channel_names.add(row["channel_names"])
                global_names.add(row["global_names"])
                shards.append(row)
                total += 1
                if len(shards) >= args.shard_size:
                    name = f"{args.prefix}-{shard_index:05d}.parquet"
                    target = os.path.join(args.out, name)
                    write_shard(shards, target, {
                        "suitaku.schema_version": args.schema_version,
                        "suitaku.feature_versions": ",".join(sorted(feature_versions)),
                        "suitaku.created_at": datetime.now(timezone.utc).isoformat(),
                    })
                    files.append({"path": name, "rows": len(shards)})
                    shards = []
                    shard_index += 1
    if shards:
        name = f"{args.prefix}-{shard_index:05d}.parquet"
        target = os.path.join(args.out, name)
        write_shard(shards, target, {
            "suitaku.schema_version": args.schema_version,
            "suitaku.feature_versions": ",".join(sorted(feature_versions)),
            "suitaku.created_at": datetime.now(timezone.utc).isoformat(),
        })
        files.append({"path": name, "rows": len(shards)})
    metadata = {
        "schemaVersion": args.schema_version,
        "featureVersions": sorted(feature_versions),
        "rows": total,
        "shards": files,
        "channels": sorted(channel_names),
        "globals": sorted(global_names),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "note": "x is the flat 34*channels tensor followed by the globals; reshape with channels/tiles/globals.",
    }
    with open(os.path.join(args.out, "_metadata.json"), "w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(f"wrote {total} rows in {len(files)} shard(s) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
