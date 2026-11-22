# GRP（順位分布モデル）— grp-v1

局開始時点の順位状況から **最終順位の分布** を推定するモデルです。勝率や和了率ではありません。`MJ.rank.setRankModel(model)` で `expectedPoints()` / `riskBias()` のヒューリスティックな順位点EVを置き換えます。

## データ

`tools/grp-dataset.js` は1局開始につき4席分のサンプルを作ります。

```json
{"v":"grp-v1","match":"2026-10-13T09:48:02.146Z","hand":2,"handIndex":2,"seat":0,
 "x":[17 floats],"rank":1,"finalScore":35000,"scoreDelta":10000}
```

- `match` は1試合を識別します。**学習・検証は試合（半荘）単位で分割**してください。同じ試合の局を両側に入れると、似た局面が検証側へ漏れて精度が楽観的になります。
- `hand` / `handIndex` は東1〜南4の局番号です（0始まり）。指標を局別に出すために使います。
- ラベル `rank` は最終順位 1–4 で、天鳳の30000点返し（オカ20）は `record.mjai.tenhou` に記録されます。順位点の比較時は rankConfig の差を適用してください。

```bash
# 自己対戦JSON / 天鳳から変換した翠卓JSON
node tools/grp-dataset.js "Saved Data" test-results/selfplay-200 --out data/grp.jsonl
python tools/grp/train_grp.py --train data/grp.jsonl --out-dir models
```

天鳳鳳凰卓を使う場合は、利用規約と権利者の許可を確認したうえで、各自の環境で `node tools/mjai-convert.js tenhou-to-suitaku game.mjlog.gz game.json --strict` により変換してください。牌譜データは同梱していません。

## 学習と分割

- `--train` と `--val` を別ファイルで渡すか、`--val-fraction` で分割します。
- 分割は `match` 単位です。`match` がない古いJSONLは1行単位のフォールバックになります。
- 乱数シードは `--seed`（既定 20261022）で固定されます。
- 出力 `grp.json` は標準化込みのMLP、`grp.onnx` は同じ MatMul/Add/ReLU/Softmax です。ONNXとJSONの最大差を学習時に検査します。

## 推論の整合性（24順列）

各席の softmax を独立に使うと、4×4行列の行は1になりますが列は1になりません。`MJ.grp.predictSeats()` は24通りの順列に射影します。

```text
score(perm) = Π_seat P_seat(rank = perm[seat])
```

これを log 空間で正規化し、各順列の確率を足し戻すため、**行の和も列の和も厳密に1**になります（浮動小数誤差のみ）。`G.sinkhorn()` は比較用に残していますが、ほぼ確定的な予測では収束が遅いため推論には使いません。

## 指標

学習時に検証セットで以下を出します。

- 局別（東1〜南4）と全体の logloss、top-1 的中率、1位的中率
- 期待順位点の MAE（天鳳 uma `[90,45,0,-135]`）
- ベースライン「現在点数順に順位を予測」の top-1 と順位点 MAE
- 4×4行列の行・列和の最大誤差

`rank` が期待順位点のMAEに使う uma は天鳳風です。Mリーグ風など別の順位点で評価する場合は、期待順位点を再計算してください。

### 自己対戦200試合の実測（試合単位8:2分割）

データ: `Saved Data` 4局 + 自己対戦200試合（`test-results/selfplay-200`）、3,916サンプル。学習 3,132 / 検証 784。

| 指標 | GRP（24順列） | 現在点数順 |
|---|---:|---:|
| top-1 的中率 | 0.891 | 0.502 |
| 期待順位点 MAE | 12.08 | 58.46 |
| 4×4行列の最大行・列誤差 | 6.7e-16 | — |
| logloss（全体） | 0.844 | — |

東1〜東4は top-1 0.944 / 期待順位点 MAE 5.2–6.2 でした。南3〜南4は検証サンプルが4件ずつしかなく、logloss 6前後・MAE 90前後と不安定です。**自己対戦由来で楽観的**であり、天鳳実データの精度ではありません。局別の数値はサンプル数とともに読んでください。

## rankBias としての比較

GRP版 `riskBias` と既存ヒューリスティックを、同じ南3〜南4開始状態で比較できます。

```bash
node tools/start-states.js <mjlog-dir> --out data/start-states.jsonl   # 既定は南3〜4
node tools/evaluate.js --seeds 200 --workers 4 --level fast \
  --start-states data/start-states.jsonl \
  --candidate-grp models/grp.json --baseline-heuristic \
  --candidate-seat seed --control --rank tenhou --out grp-rankbias.json
```

`--candidate-grp` / `--baseline-grp` は片側だけにモデルを適用します。`--baseline-heuristic` はグローバルモデルを無視して既存EVを使います。

2026-11-22の自己対戦54状態（40半荘から抽出、南3〜4）・200シードでは、GRP版 − 既存のペア差は **0.00点（95% CI −0.63〜+0.63、クラスタsd 81.6）** で「改善未確認」でした。開始状態の分散が大きく、0.2点の効果検出には約64万シードが必要と試算されます。天鳳実データでの再評価が必要です。

## 注意

- 順位分布は最終順位であって、和了率・放銃率ではありません。
- 自己対戦データは特定のAI同士の結果に偏ります。天鳳データと混ぜる場合は `match` と出所を分けて評価してください。
- サンプル数が少ない局（南3〜4）は過学習しやすいため、局別指標は必ずサンプル数と併記してください。
