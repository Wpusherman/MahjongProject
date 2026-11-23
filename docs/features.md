# 特徴量スキーマ

`src/features.js` の `MJ.features.version` は **`obs-v1`** です。テンソルの形・チャンネル順・グローバル特徴の順序を変えるときは、この版と `docs/features.md` を同時に更新してください。学習データ側は `x.v`（JSONL）と `feature_version`（Parquet）に版を記録します。

## テンソル

- 牌チャンネル: **34種 × 25チャンネル**（固定長、牌種 0–33）
- グローバル特徴: **31個**
- 平坦化した長さ: `25 * 34 + 31 = 881`
- 牌種: 萬子 0–8、筒子 9–17、索子 18–26、東南西北白發中 27–33
- 値はすべて `Float32`。カウント系は 4 枚で 1.0 に正規化し、フラグ系は 0/1 です。

`MJ.features.encode(observation)` は `{ version, shape: { channels, tiles, globals }, channelNames, globalNames, data }` を返します。入力は `Game#getObservation(seat)` の公開情報のみで、他家の手牌ID・牌山・王牌・裏ドラは含みません。

## 牌チャンネル（25）

| # | 名前 | 定義 |
|---:|---|---|
| 0 | `hand` | 自分の手牌（ツモ牌を含む）。牌種ごとの枚数 / 4 |
| 1 | `hand_red` | 自分の手牌にある赤5の牌種（0/1） |
| 2 | `meld_self` | 自分の副露・槓の牌（枚数 / 4） |
| 3 | `dora` | ドラ表示牌から決まるドラ牌種（最大 1.0） |
| 4 | `dora_indicator` | ドラ表示牌そのもの（各 0.25、最大 1.0） |
| 5 | `unseen` | 自分から見た未見牌枚数 / 4（山の透視ではない） |
| 6 | `river_self` | 自分の河の牌（枚数 / 4） |
| 7 | `last_self` | 自分の直前の打牌（one-hot） |
| 8 | `tsumogiri_self` | 自分のツモ切り牌（枚数 / 4） |
| 9–13 | `opp1_river` … `opp1_meld` | 下家の河・直前打牌・ツモ切り・リーチ宣言牌・副露 |
| 14–18 | `opp2_river` … `opp2_meld` | 対面の同上 |
| 19–23 | `opp3_river` … `opp3_meld` | 上家の同上 |
| 24 | `safe_vs_riichi` | リーチ者に対する現物・リーチ後通過牌（リーチ者数で平均） |

`oppN` は `(自分の席 + N) % 4` です。すべて公開情報（河・副露・リーチ）だけを使います。`score*` / `diff*` / `riichi*` のスロットは絶対席番号ではなく **起家から見た席順**（0=起家、`startDealer` 省略時は 0）です。`seat` 番号そのものは特徴量に入りません。

## グローバル特徴（31）

| # | 名前 | 定義 |
|---:|---|---|
| 0–3 | `score0` … `score3` | 4家の点数（25,000 基準、/100,000）。スロットは起家から見た席順（0=起家） |
| 4–7 | `diff0` … `diff3` | 自分の点数 − 各家の点数（/100,000）。同じく起家からの席順 |
| 8–11 | `wind_e` … `wind_n` | 自分の自風（one-hot） |
| 12 | `dealer` | 自分が親なら 1 |
| 13 | `south_round` | 南場なら 1 |
| 14 | `honba` | 本場 / 10 |
| 15 | `riichi_sticks` | 供託 / 10 |
| 16 | `live_remaining` | 生牌山の残り / 70 |
| 17 | `turn` | 巡目 / 100 |
| 18 | `hands_left` | 残り局数 / 8 |
| 19–22 | `riichi0` … `riichi3` | 各家のリーチ状態（起家からの席順） |
| 23 | `threat` | リーチ者がいる |
| 24 | `furiten` | 自分のフリテン |
| 25–27 | `open_melds_opp0` … `opp2` | 各家の副露数 / 4 |
| 28–30 | `hand_count_opp0` … `opp2` | 各家の手牌枚数 / 14 |

## ラベル

`MJ.features.dataset(record)` は行動直前の観測からサンプルを作ります。

- `discard`: `{ kind, tile, riichi, tsumogiri, forced, canRiichi }`（`canRiichi` はその打牌時点でリーチ宣言が可能だったか）
- `tsumo`: ツモ和了（`end` イベント直前の観測）
- `ron` / `pon` / `chi` / `kan` / `pass`: 応答判断
- `meta.kind`: `discard` / `response` / `end`
- 天鳳mjlog変換は実際の `call` だけを記録し `response` を持ちません。その場合は各打牌後に `Game#callOptions` で合法手を再構成し、次のイベント（`call` / ロンの `end` / それ以外）から鳴き・ロン・見送りをラベル付けします（`meta.synthetic=true`、`meta.ron/pon/kan/chi` に合法手の有無）。入力は公開観測のみで、他家の手牌・牌山は含みません。

## JSONL

`node tools/features.js <record> <out.jsonl>` の1行:

```json
{"v":"obs-v1","match":"2026112314gm-...","hand":0,"event":12,"seat":0,"channels":[...],"globals":[...],
 "shape":{"channels":25,"tiles":34,"globals":31},"x":[...881 floats...],
 "label":{"kind":"discard","tile":4,"riichi":false,"tsumogiri":true,"forced":false,"canRiichi":false},
 "meta":{"version":"obs-v1","hand":0,"eventIndex":12,"seat":0,"turn":3,"kind":"discard","riichi":false}}
```

`match` は試合単位のtrain/val分割に使います。

## Parquet

`python tools/to_parquet.py features-*.jsonl --out data/parquet` は以下を保存します。

- 列: `schema_version`, `feature_version`, `hand`, `event`, `seat`, `kind`, `tile`, `riichi`, `tsumogiri`, `forced`, `channels`, `tiles`, `globals`, `x`（`list<float>`）, `channel_names`, `global_names`, `meta`
- ファイルメタデータ: `suitaku.schema_version`, `suitaku.feature_versions`, `suitaku.created_at`
- `_metadata.json`: シャード一覧、行数、チャンネル名、グローバル名、版

`x` は平坦化したまま保存します。読み込み側で `channels` / `tiles` / `globals` を使って `reshape(25, 34)` と末尾 31 に分けてください。

## GRP（順位分布モデル）

`src/grp.js` の版は **`grp-v1`** です。`MJ.grp.FEATURES` の順序が契約です。

| # | 名前 | 定義 |
|---:|---|---|
| 0–3 | `score0` … `score3` | 4家の点数 / 1,000（起家から見た席順） |
| 4–7 | `diff0` … `diff3` | 自分の点数 − 各家の点数 / 1,000（起家から見た席順） |
| 8 | `honba` | 本場 / 10 |
| 9 | `riichi_sticks` | 供託 / 10 |
| 10 | `hands_left` | 残り局数 / 8 |
| 11 | `round_progress` | 局番号（0–8） / 8 |
| 12 | `dealer` | 自分が親なら 1 |
| 13–16 | `seat0` … `seat3` | 自分の席（one-hot、起家からの相対位置） |

ラベルは **最終順位 1–4** です。`node tools/grp-dataset.js` が `{ v, match, hand, handIndex, seat, x, rank, finalScore, scoreDelta }` を出力し、`python tools/grp/train_grp.py` が MLP を学習して `grp.json` と `grp.onnx` を書き出します。`grp.json` は `MJ.rank.setRankModel()` で読み込み、`MJ.rank.expectedPoints()` のヒューリスティックな順位点EVを置き換えます。

`match` 単位で train/val を分割し、局別（東1〜南4）の logloss・top-1・期待順位点MAEと「現在点数順」ベースラインを出力します。`MJ.grp.predictSeats()` は4席の独立な行を24通りの順列確率に射影するため、4×4行列の行の和も列の和も1になります。データ作成・学習・比較の詳細は [grp.md](grp.md) を参照してください。
