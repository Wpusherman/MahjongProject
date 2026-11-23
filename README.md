# 翠卓 — リーチ麻雀

ブラウザーで動く四人打ちリーチ麻雀です。**`mahjong.html` をダブルクリックして、Edge / Chrome / Firefox で開いてください。** サーバーやネット接続は不要です。牌フォントもHTMLに埋め込んでいます。

## 遊び方

1. 東風戦または半荘戦と、対戦AI「思考型／標準」を選びます。
2. 自分の手番で手牌をクリックして打牌します。ツモ牌は自分から見て左端です。
3. リーチボタンを押すと、宣言できる打牌だけが選択可能になります。鳴き・和了は表示されたボタンで操作します。リーチ後は自動ツモ切りになり、ツモ・ロンは引き続き手動で選択します。待ちが変わらない暗槓ができるときは、自動ツモ切りの前に「槓／ツモ切り」を選べます（`rules.riichiAnkan`）。
4. 「高速進行」でCOMの待ち時間を短縮できます。「AIのヒント」は推奨牌と受入を表示します。

### 表示

- 河は全員 **6枚・6枚・残り全部** の3段。3段目は横へ伸びます。
- リーチ宣言牌は横向き。鳴かれた場合は次の捨て牌を横向きにします。
- ツモ切りは各プレイヤーから見て左端からアニメーションします。河の左下の小さな点もツモ切りを示します。
- 直前の捨て牌には金色の枠が付きます。
- ドラ表示欄は常に5枚分。未開示の表示牌は裏向きです。
- 牌の絵柄は **GL-MahjongTile**（Gutenberg Labo）。萬・筒・索・赤牌をCSSで色分けしています。

## ルール

四人打ち、25,000点持ち、赤五萬・赤五筒・赤五索各1枚。喰いタン・後付けあり、喰い替えなし。複数ロンは頭ハネです。

- 親和了・親テンパイで連荘。流局時は本場が増加します。
- 東風は東4局、半荘は南4局まで。飛び終了（0点は続行）あり。
- 和了やめ・テンパイやめ・南入／西入なし。最終局も親が連荘します。
- 終局時の残供託はトップへ。同点は開始時の席順を優先します。順位は素点で決めます。終局画面の順位点は `src/rank.js` の設定（既定は天鳳風）で計算し、対局の点数の移動には使いません。
- 順位点は `MJ.rank.CONFIGS` の `tenhou`（[90,45,0,-135]）、`mleague`（[50,10,-10,-30]＋素点係数）、`raw`（素点のみ）から選べます。`MJ.rank.setDefault(name)` または `MJ.ui.rankConfig = 'mleague'` で切り替えます。`returnScore` を開始点より大きくするとオカを1位に加算します。
- 四風連打・四家立直・複数人による四槓は途中流局。
- 九種九牌・流し満貫・包は採用していません。三麻はありません。
- 数え役満あり、切り上げ満貫なし。役満は複合加算。大四喜・四暗刻単騎ロンはダブル役満です。国士十三面・純正九蓮・四暗刻単騎ツモはシングル扱いです。
- 槓ドラ即乗り。最大4槓。嶺上牌4枚、ドラ／裏ドラ表示各5枚は重複のない14枚の王牌に割り当てています。嶺上ツモごとに生牌山の末尾を王牌へ補充します。
- リーチ後の暗槓は `rules.riichiAnkan` で切り替えます。`wait`（既定・天鳳準拠）は槓の前後で待ち牌の集合が完全に一致する場合のみ、`strict` はさらに全和了分解でその牌が刻子になる場合のみ、`none` は不可です。対象はツモ牌が4枚目になる暗槓だけで、手牌の4枚目を使う送り槓は認めません。槓後は嶺上ツモ → 槓ドラ → 自動ツモ切りに戻ります。
- 起家は対局シードから決定的に選ばれます（`rules.startDealer: "random"`、テスト・golden用に 0〜3 で固定可）。起家決めは牌山の乱数とは別系列なので、同じシードの牌山は変わりません。局表示・自風・同点時の順位は起家から見た席順で決まります。
- 暗槓は牌種だけを公開し、外側2枚の伏せ牌に赤5があっても赤かどうかは公開しません（内側の公開牌にある赤はそのまま見えます）。他家の手牌は枚数のみ、裏ドラ・牌山・他家の手牌IDは観測ビューに含めません。
- 対局中の牌譜（localStorageへの自動保存・途中書き出し）はマスクされます。牌山・他家の配牌/ツモ・他家の鳴き候補・他家AIの解析は含まれず、終局後に保存した牌譜だけが全情報を含みます。`MJ.ui.record` も対局中はマスク済みのコピーを返します。
- 他家の応答チェックは、鳴ける・ロンできる場合もできない場合も同じ固定待ち時間で行います。待ち時間の差から他家の手牌を推測できないようにしています。
- フリテンは全待ちを判定。見逃し同巡フリテン・リーチ後見逃しフリテンあり。加槓の搶槓、国士による暗槓の搶槓に対応します。

## AI

### 2026-10-19 更新（public-search-4）

評価関数を**ルート対応**にしました。これまでは向聴数だけが通常形・七対子・国士の最小値を取り、形・受入・打点は通常形で見積もっていたため、「4向聴なのに3ブロック」のような食い違いが出ていました。

- 閉じた手について通常形・七対子・国士をそれぞれ評価し、**向聴数が最小のルートを採用**します。受入・形・打点見積りを採用ルートにそろえます。
- 七対子ルートは対子数と単独牌の伸び、国士ルートは幺九牌の種類と対子で形を評価し、打点も七対子・国士の役で見積もります。
- 「AIのヒント」と検討画面は採用ルート（七対子／国士）を表示します。
- 向聴計算の標準形にキャッシュを追加し、評価の計算量増加を相殺しています。

### 2026-10-13 更新（public-search-3）

いただいた東1局の20件のコメントをもとに、序盤の同点評価、字牌の役割、手変わり、守備を見直しました。

- 孤立字牌は重なり・役牌・自風・場風・残り枚数を評価。孤立数牌は両面・嵌張・辺張への伸びを評価します。単純な固定順位にはしません。
- 重複しない面子・対子・塔子の分解から、5ブロック／6ブロックの候補と雀頭の有無を比較します。第6ブロックを余分な面子として加点せず、選択保留の価値として扱います。
- 思考型は有力4候補について、**次の全34種のツモを未見牌枚数で重み付けし、その後の打牌も比較**します。向聴数が変わらない手変わりも対象です。
- その先は、残り自摸回数を使う有限巡目の状態遷移近似でテンパイ・ツモ和了率を評価します。テンパイの待ち・役・打点は既存の和了／点数エンジンで計算します。
- 現物、立直後に通った牌、左右それぞれの筋、壁・ワンチャンスを使って放銃リスクを推定。3枚見えの字牌も単騎があるので0%にはしません。
- 鳴く場合は喰い替え禁止を適用した**鳴いた後の打牌**まで比較します。見送りも含めて評価を保存します。

期待収支は **推定和了収入 − 現在の打牌による推定放銃損失 − 将来の押しによる推定損失**です。通常時の打牌選択には牌効率・形評価も併用します。**厳密な四人麻雀期待値や、学習済み・実測で校正済みの確率ではありません。** 他家和了、ロン機会、将来の副露・打点は近似で、mahjong-cppのC++エンジンを搭載したものではありません。

判断時点の未見牌を毎回更新し、先読みで引いた牌も残数から減らします。未見牌は「自分の手牌・河・副露・ドラ表示以外」であり、実際の山の残数を透視したものではありません。相手の手牌・王牌内の未知牌も含みます。

参考資料・コメントへの対応状況は [AI_REVIEW.md](AI_REVIEW.md) を参照してください。

思考型は公開情報だけを使うヒューリスティック探索型です。相手の手牌・未来のツモ・裏ドラは参照しません。順位点圧力（`rankBias`）は点差・残り局数・順位点設定から押し引きを補正します。`rankBias:false` で旧来の順位点無視に戻せます。

- 通常形・七対子・国士の向聴数と未見牌に基づく受入枚数
- 有力な候補について、向聴数を改善するツモの次の受入まで探索
- ドラ・赤牌を残す評価、フリテン待ちを避ける評価
- リーチ相手への現物・筋・見えている枚数による危険度評価と押し引き
- 役の見込みを考慮した鳴き、リーチ、槓の判断
- 点差・残り局数・順位点設定からリスクの価値を補正（リード時は放銃を重く、追う側は押しやすく）

学習済みの競技AIではなく、実力の段位・勝率は未測定です。牌譜に候補評価を残しているため、打牌への指摘をもとに評価関数を改善できます。

## core API（JS）

`src/core.js` はUI・AIから独立した対局エンジンのAPIです。将来のRust移植（libriichi相当）と同じ操作列で扱えるよう、1局を決定的に再生できます。

```js
const core = await MJ.core.new_game({ dealer: 0, scores: [25000, 25000, 25000, 25000] }, 20261015);
while (!core.is_terminal()) {
  const pending = core.current();              // { seat, type: 'discard' | 'tsumo' | 'kan' | 'call', legal }
  const action = choose(core.observe(pending.seat), core.legal_actions(pending.seat));
  const events = await core.step(action);       // 前回のstep以降のイベント列
}
const result = core.final_result();
```

- `new_game(config, seed)` / `new_game` は牌山をシードから生成し、最初の意思決定まで進めて返します。`create(config, seed)` は未開始のCoreを返します。`config.dealer` を省略すると `config.rules.startDealer`（`"random"` または 0〜3）から起家を決めます。観測ビューには `startDealer`・`seatOrder`（起家からの相対位置）・`roundNumber` が入ります。
- `observe(seat)` は `game.getObservation(seat)` と同じ公開情報ビューです。他家の手牌ID・牌山・王牌・裏ドラは含みません。
- `legal_actions(seat)` は現在の意思決定に対する合法手を返します。打牌（リーチ有無）、ツモ/見送り、槓、ロン/ポン/チー/大明槓/見送りを含みます。
- `step(action)` は合法手を検証して状態を進め、発生したイベントを返します。不正な手は状態を変えずに例外になります。
- `is_terminal()` / `final_result()` で終局と結果を取得できます。
- `test/golden/core-*.json` は操作列・全イベント・最終点数を保存したgoldenです。`node tools/core-golden.js` で再生成し、`test/core.test.js` が同一イベント列を検証します。Rust coreは同じ操作列を再生して1イベント単位で比較できます。

## 牌譜・検討

右上の「牌譜を保存」から **JSON** または **テキスト** をダウンロードできます。開始画面の「牌譜を読み込む」では、翠卓JSONに加えてmjai（JSON Lines）と天鳳mjlog（XML）を直接開けます。局選択・イベントスライダー・前後ボタンで再生でき、全員の手牌表示も切り替えられます。

- **盤面左半分をクリックで前へ、右半分をクリックで次へ。** キーボードの←・→にも対応します。
- スライダーは盤面の下です。ドラ・応答・リーチ成立などを含む記録イベント単位で移動します。
- 検討時のツモ切り牌は少し暗く表示します。
- 新牌譜の鳴き判断には、見送り／ポン／各チー／大明槓の推定収支と「鳴き優位%」を表示します。実際の副露イベントでも対応する判断を表示します。
- 「鳴き優位%」は `(最良鳴きEV − 見送りEV) / max(100, |鳴きEV|, |見送りEV|) × 100`。**鳴いた方が勝つ確率ではありません。** 負なら見送り優位です。小差は見送る方針なので、僅かにプラスでも見送りになることがあります。
- 旧牌譜や人間の打牌は **「現AIで再計算」** で現在のAI評価を確認できます。対局当時の評価と区別して表示し、元の記録は書き換えません。

### mjai・天鳳牌譜の変換

教師あり学習用の中間形式として mjai（JSON Lines）を採用しています。`src/mjai.js` と `node tools/mjai-convert.js` で変換できます。

```bash
node tools/mjai-convert.js to-mjai suitaku.json out.jsonl
node tools/mjai-convert.js to-mjai suitaku.json seat0.jsonl --seat 0 --mask-other-draws
node tools/mjai-convert.js from-mjai out.jsonl back.json --strict
node tools/mjai-convert.js tenhou game.mjlog.gz out.jsonl
node tools/mjai-convert.js tenhou-to-suitaku game.mjlog.gz game.json --strict --verify-wall
node tools/mjai-smoke.js out.jsonl
```

- 翠卓JSON ↔ mjai は双方向。天鳳 mjlog（XML / gzip）→ mjai → 翠卓JSONも変換できます。
- 取り込み時は牌山を136枚の一意な牌IDで再構築し、`MJ.record.snapshot` で全イベントをリプレイして、点数合計・最終点数・イベント番号を検証します。失敗した局は警告を出して終了コード1にします。
- 赤なし・喰いタンなし・三麻・複数ロン（頭ハネと異なる）に加え、天鳳の九種九牌（`yao9`）・流し満貫（`nm`）・包（`paoWho`）もルール差としてフラグを付けます。`--strict` では除外（例外）にします。天鳳の三麻は四人打ちcoreでは扱いません。
- 天鳳の `AGARI`/`RYUUKYOKU` の `sc` は「和了前点数, 増減」のペアとして読みます。最終点数は `before + delta` です。
- 天鳳の30000点返し（オカ20）は `record.mjai.tenhou` に `rankConfig` 差として記録します。翠卓の `rank.tenhou` は25000点返しなので、順位点を比較するときはこの差を適用してください。
- `--verify-wall` は `<SHUFFLE seed="mt19937ar-sha512-n288-base64,...">` から牌山を再現し、配牌・生牌山のツモ順・ドラ/裏ドラ・嶺上牌を牌譜と比較します。天鳳の牌山は先頭14枚が王牌、末尾から配牌・ツモという配置です。物理コピー番号はmjai変換で保持されないため、牌種と赤5で比較します。嶺上牌は先頭4枚と仮定しています（手元の実サンプルにカンがなく、嶺上順は未確認）。
- `--seat N --mask-other-draws` は座席視点の学習データ用に、他家の `tsumo` を `pai: "?"` にします。マスク済みファイルは再変換できないので、学習入力専用です。
- `tools/mjai-smoke.js` は依存なしでイベント型・席・牌表記・点数合計を検査します。`--command "..."` でMortal系ツールにファイルを渡し、終了コードを確認できます。
- mjaiは牌種と赤5を保持しますが、同じ牌種の物理コピー番号は保持しません。天鳳の役IDは既知のものを日本語名に変換し、未知IDは `yaku_<id>` とします。
- 天鳳・雀魂などの牌譜は各配布元の利用規約に従ってください。本リポジトリは牌譜データを同梱・再配布しません。学習・検討に使う場合は、各サービスの規約と権利者の許可を確認してください。雀魂形式の直接変換は未実装です。

### 特徴量・教師ありデータ

`src/features.js` は観測ビューを教師あり学習用のテンソルに変換します。`node tools/features.js <牌譜> <out.jsonl>` でサンプルを書き出せます。

- 牌チャンネルは **34種 × 25チャンネル**: 自分の手牌、赤5、副露、ドラ、ドラ表示牌、未見牌、自分の河・直前の打牌・ツモ切り、各家の河・直前の打牌・ツモ切り・リーチ宣言牌・副露、リーチ者に対する安全牌。
- グローバル特徴は31個: 4家の点数と点差、自風、親、南場、本場、供託、残りツモ、巡目、残り局数、リーチ状況、脅威、フリテン、相手の副露数・手牌枚数。
- ラベルは打牌（牌種・リーチ・ツモ切り）、ロン、ポン、チー、槓、見送り。打牌サンプルにはリーチ中の強制打牌フラグも付きます。
- サンプルは行動直前の `getObservation(seat)` から作るため、他家の手牌・牌山・裏ドラはテンソルに入りません（`test/features.test.js` で他家の手牌を入れ替えてもテンソルが不変なことを検証）。
- JSONLの1行が1サンプルです。ゲーム単位でファイルを分ければシャードになり、行単位のストリーミングDataLoaderで読めます。

チャンネル定義とスキーマ版（`obs-v1`、34×25＋31）は [docs/features.md](docs/features.md) にあります。チャンネルや順序を変えるときは版を上げてください。

Parquetが必要な場合は `tools/to_parquet.py` を使います（`pyarrow` が必要）。

```bash
python tools/to_parquet.py features-*.jsonl --out data/parquet --shard-size 100000
```

- シャード分割、行数・チャンネル名・グローバル名を `_metadata.json` に記録します。
- ファイルメタデータに `features-parquet-v1` と `feature_version`（`obs-v1`）を保存します。
- `x` は881次元の `list<float>` のまま保存します。学習側で `reshape(25, 34)` と末尾31に分けます。

### 天鳳一括パイプライン（教師あり学習）

`tools/tenhou-pipeline.js` は天鳳mjlogのディレクトリを **mjai（strict）→ 翠卓record → features JSONL** まで一括変換し、失敗率とルール差による除外数をレポートします。

```bash
node tools/tenhou-pipeline.js <mjlog-dir> \
  --out-features data/features/tenhou.jsonl --out-report data/tenhou-report.json
```

- 三麻・九種九牌・流し満貫・包・複数ロン・赤なし・喰いタンなし・検証失敗を理由別に数えます。`--allow-diffs` でルール差を除外せず変換できます。
- レポートには試合数、局数、サンプル数、ラベル別件数、変換失敗率、除外率、試合あたりの局数・サンプル数、処理時間を出します。
- 1万半荘規模はデータ量に比例して時間がかかりますが、ストリーミングでJSONLに追記します。Parquet化は `python tools/to_parquet.py` を使います。
- 牌譜データは同梱していません。利用規約と権利者の許可を確認したうえで、各自の環境で用意してください。

### 順位分布モデル（GRP）

`src/grp.js` は Game Result Prediction の入力スキーマ（`grp-v1`、17特徴）と推論器です。局開始時点の (局, 本場, 供託, 4人の点数, 残り局数, 席) から最終順位の分布を推定します。詳細と実測値は [docs/grp.md](docs/grp.md) を参照してください。

```bash
node tools/grp-dataset.js "Saved Data" test-results/selfplay-200 --out data/grp.jsonl
python tools/grp/train_grp.py --train data/grp.jsonl --out-dir models --hidden 64,64
node tools/evaluate.js --seeds 20 --workers 8 --match tonpu --grp models/grp.json
```

- **試合単位で train/val を分割**します。データセットの `match` 列で半荘ごとにまとめ、同じ試合の局が検証側へ漏れないようにしています。乱数シードは `--seed` で固定します。
- 検証指標は局別（東1〜南4）と全体の logloss、top-1 的中率、1位的中率、期待順位点 MAE です。「現在点数順に順位を予測」をベースラインとして併記します。
- 推論は **24通りの順列確率** に射影します。4人×4順位の行列は行の和も列の和も厳密に1になり、4席がそれぞれ1つの順位を占めることが保証されます（`MJ.grp.predictSeats`）。テストは `test/grp.test.js`。
- `grp.json` はNumPyで学習したMLP（標準化込み）で、`MJ.rank.setRankModel(model)` に渡すと `MJ.rank.expectedPoints()` のヒューリスティックな順位点EVを置き換えます。開始画面の「順位分布モデル（GRP）を読み込む」からも読み込めます。`MJ.rank.clearRankModel()` で戻せます。
- `grp.onnx` は同じMatMul/Add/ReLU/Softmaxで、ONNX Runtime系から読めます。学習時にJSONとONNXの出力差を検査します。ブラウザーで使う場合は `onnxruntime-web` を追加してください（このリポジトリにはまだ依存を追加していません）。
- 学習データは天鳳mjlogを `tools/mjai-convert.js` で変換した翠卓JSON、または翠卓の自己対戦JSONです。天鳳は30000点返し（オカ20）を `record.mjai.tenhou` に記録します。牌譜データ自体は同梱しません。
- `--candidate-grp` / `--baseline-grp` で片側だけGRPにできます。`--start-states` と組み合わせると、南3〜南4の実戦に近い開始状態で **GRP版rankBiasと既存rankBiasを直接比較**できます。
- 自己対戦200試合（4,724サンプル、試合単位8:2分割、match重複0・重複サンプル0）の実測は top-1 0.444（点数順 0.434）、期待順位点 MAE 54.02（60.98）、行列の最大行・列誤差 4.4e-16。**東1局の top-1 は0.279**（閾値0.35未満）です。以前の 0.891 は自己対戦生成で毎局同じ牌山を使っていたアーティファクトで、修正済みです。全体では点数順をわずかに上回るものの、東4では負けており、自己対戦由来の限界があります。南3〜4はサンプルが少なく不安定です。詳細は [docs/grp.md](docs/grp.md)。
- **天鳳実データ（鳳凰卓）で再学習**: `tools/tenhou-fetch.js` で取得した143件からstrict変換した118試合・4,812サンプル（試合単位8:2、学習3,820 / 検証992、重複0）。検証 top-1 0.4435、4×4ジョイント top-1 0.4637（点数順0.4899）、期待順位点MAE **54.10（点数順55.07）**、行列誤差4.4e-16、ONNX差4.3e-08。局別top-1は東1 **0.298**（正常範囲0.25〜0.30）/ 東2 0.288 / 東3 0.308 / 東4 0.394で、自己対戦の0.279/0.412/0.471/0.547より南場が平坦です。実データでは順位予測に和了やめ・押し引き・相手力量など特徴量外の情報が必要で、全体top-1は点数順に負けますがMAEは改善します。

### 教師あり方策ネット（2026-11-23）

天鳳鳳凰卓の牌譜から、obs-v1（25×34 + 31）を入力とするResNet方策ネットを学習できます。

- 取得: `node tools/tenhou-fetch.js --hours 6 --logs 240 --out data/tenhou`。鳳凰卓（四鳳・赤・喰いタン）の牌譜IDを時間別インデックスから拾い、`tenhou.net/0/log/?<id>` を保存します。**牌譜データは `data/`（gitignore）に置き、コミットしません。**
- 変換: `node tools/tenhou-pipeline.js data/tenhou --out-features ... --out-report ...`。strictでルール差を除外し、失敗率・除外理由・判断数をレポートします。今回の143件では118件成功・25件除外・失敗0、1,203局・58,458判断（打牌58,026・ツモ432）でした。
- 方策データ: `node tools/policy-dataset.js data/tenhou --out test-results/policy-tenhou.jsonl`。Tenhouには `response` がないため、各打牌後の合法手と次のイベントから鳴き/ロン/見送りを再構成します。73,839サンプル（打牌58,026・見送り12,445・ポン1,385・チー947・ロン600・ツモ432・カン4、リーチ陽性878）。
- 学習: `python tools/policy/train_policy.py --data test-results/policy-tenhou.jsonl --out-dir test-results/policy-model-tenhou --width 128 --blocks 10 --epochs 2 --max-discard 20000`。試合単位でtrain/valを分け、打牌34・リーチ2・鳴き5・和了2の4ヘッドを同時学習します。クラス重みは学習時のみ使い、推論時に `log p = log softmax − log w` で補正します。
- 推論: `policy.onnx` を `onnxruntime-node` で実行。`src/policy.js` の `MJ.policy.predictBatch` がバッチ推論、`--candidate-policy FILE` がduplicate評価への接続です。ONNXセッションはワーカー間でcloneできないため、各ワーカーがファイルから1回ロードします。`node tools/policy-bench.js --model <onnx> --samples 1024` でバッチ1/8/32/128の推論速度を記録できます（実測 235/307/327/376 samples/s、CPU）。試合はターン逐次なのでin-gameはbatch=1です。
- 指標は判断種別ごと（打牌top-1、リーチ一致率、鳴き5クラスの混同行列、和了）に出します。**小規模データのため、既存AIに対する強さの主張は別途duplicate評価が必要です。** 実測（118試合・73,839サンプル）: 10ブロック/128chは打牌top-1 43.8%・リーチ55.4%・鳴き53.5%、duplicate **−7.31点（95% CI −12.85〜−1.77）**。小型4ブロック/64chは打牌49.4%・duplicate **−6.19点（95% CI −11.88〜−0.50）**。現段階ではパラメータ数よりデータ量が律速で、既存ヒューリスティックに負けます。詳細は [AI_REVIEW.md](AI_REVIEW.md)。

### 評価（duplicate自己対戦）

`node tools/evaluate.js` はワーカースレッドでduplicate自己対戦を並列実行します。既定は **1対3 × 4席ローテーション × 同一牌山 × handicap開始点** です。各シードで候補が4席を1回ずつ打ち、4席分の候補順位点の平均を1クラスタとして95%信頼区間を出します。

> **0点になる理由（以前の記述の訂正）**
> 同点開始では `rankBias` が働かず、候補と基準AIの行動が一致します。すると同じ牌山の4局が同じ対局になり、候補の4席分の順位点はその1局の4席分（ゼロサム）になるため、平均がちょうど0になります。これは「rotateが構造上つねに0」なのではなく、**両policyが同じ対局を再生したときの縮退**です。開始点をずらすhandicapでは4局が異なる展開になるため、クラスタ平均が意味を持ちます。ただしpolicy差が行動に現れない場合（同一AI同士など）は、handicapでも4局が一致してsd=0になります。その場合は率の指標を見るか、`--candidate-seat seed --control` で1シード1標本のペア比較を使ってください。

```bash
node tools/evaluate.js --seeds 2000 --workers 12 --rank tenhou --out report.json
node tools/evaluate.js --seeds 1000 --workers 12 --rank tenhou --candidate-seat seed --control --baseline-no-rank-bias --out paired.json
node tools/evaluate.js --seeds 500 --workers 8 --match tonpu --rank tenhou --out match.json
node tools/evaluate.js --seeds 1000 --workers 12 --start-states data/start-states.jsonl --out south.json
node tools/evaluate.js --seeds 500 --workers 8 --level fast --out fast.json
```

- `--score-pattern handicap` は既定です。開始点数 `40,000 / 25,000 / 20,000 / 15,000` をシードごとに回転させ、候補の開始位置を4席で変えます。`--score-pattern even` は同点開始です。
- `--start-states FILE` は天鳳mjlog（または翠卓JSON）から抽出した南3〜南4の開始状態を使います。`node tools/start-states.js <dir> --out data/start-states.jsonl`（既定は南3〜4）。`scores`（供託除く）、`dealer`、`honba`、`riichiSticks`、`handIndex` を読みます。東風のみのディレクトリには南3〜4がないため、半荘データを使うか `--all` を付けてください。
- 検出力レポートは既定で出力します。実測したクラスタ標準偏差から、効果量 0.2 / 0.5 / 1.0 点を検出するのに必要なシード数とゲーム数を出します（正規近似 `n = (1.96·sd/effect)²`）。
- `--divergence` は同一局面でcandidateとbaselineの選んだ行動（打牌・リーチ・鳴き/ロン/パス）を比較し、`action divergence` を出します。配線が正しければ同一policyで0%、違うpolicyでは非0になります。南3〜4開始状態の実測: rankBiasあり/なしは **0.1%（12/8092判断）**、GRP版/既存は **0.7%（33/4834判断）**。分岐が起きる局面が少ないことが、順位点差がほぼ0であることの一因です。
- `--profile` で候補評価1回あたりの内訳（向聴・受入・形・点数・先読み・危険度）を出します。
- `--level fast` は評価専用の軽量探索です。根候補を12に絞り、非選択候補は受入上限で近似します。標準設定との打牌一致率は98.6%（ランダム公開局面1000件、`node tools/divergence.js --hands 1000 --fast`）。`--root-candidates 5` まで下げると高速ですが一致率は約51%まで落ちます。
- `--match tonpu|hanchan` は通し対局です。`rankBias` は点差が動いて初めて働くため、通し対局も併用してください。
- `--candidate-no-rank-bias` / `--baseline-no-rank-bias` で順位点圧力を無効化できます。`--candidate-grp` / `--baseline-grp` / `--baseline-heuristic` で片側だけGRPモデルにできます。
- 指標: 平均順位点、平均順位、順位分布、和了率・ツモ率・ロン率・放銃率・副露率・リーチ率、平均素点差、ペア差、検出力、スループット。`--profile` は位相別の時間も出します。
- 95%信頼区間は正規近似です。rotateでは「1シード＝4局のクラスタ」を1標本として数え、4席を独立標本にはしません。`--candidate-seat seed` は1シード1標本です。
- 新しいモデルの採用は、ペア差またはクラスタ差のCIが0をまたがないことを条件にするのが安全です。短い評価は牌山への過適合を含みます。
- 2026-11-22の開始状態モード（南3〜4の自己対戦54状態、fast、`--candidate-seat seed --control`、500シード）: rankBiasあり−なしのペア差は **+0.27点（95% CI −0.26〜+0.80）** で「改善未確認」。クラスタsd 79.9のため0.2点検出には約61万シードが必要という試算です。同点開始の旧計測（standard、1000シード）は **+0.18点（95% CI −0.17〜+0.53）**、raw 200シードは0.00（設計上）。GRP版rankBiasと既存の比較は [docs/grp.md](docs/grp.md)。
- **2026-11-23 順位点EV版**: 押し引き・リーチ・鳴き・和了見逃しで「和了時/放銃時/流局時の期待順位点」を直接比較する経路を追加しました（`rankOrder` / `rankRiichiEnabled` / `rankCallEnabled` / `rankCallMargin`、最終局は `finalResult` の決定的順位点）。**既定は和了見逃しのみ**です。天鳳実データ由来の南3〜4開始状態312件・200シード・`--control` で、既定は **0.00点（95% CI −0.16〜+0.16、分岐0.4%）**、フルrank EVは **−3.04点（95% CI −5.05〜−1.03、分岐19.4%）** と悪化しました。鳴き42%・リーチ12%（基準は13.8%・29.0%）に偏るためで、フルrank EVは `test-results/weights/full.json` の実験用オプトインに留めます。詳細と分岐10例は [AI_REVIEW.md](AI_REVIEW.md)。

### 高速化（2026-11-22）

- 向聴計算をスート別の分解テーブル＋50状態のDPに置き換え、手牌ハッシュのFIFOキャッシュ（標準形20万・総合8万）を付けました。元のDFSは `S.standardReference` として回帰テストに残しています。
- 受入計算は「手牌+1牌」の全34種を回す前に、改善し得る牌だけを列挙します（標準形は±2以内、七対子・国士は専用規則）。改善牌リストは13枚手牌＋routeでキャッシュし、スート別オプションは3スートを再利用します。
- `blockShape` は葉ごとの配列・ソート・オブジェクト生成を削減し、約78µs/回 → 約32µs/回にしました。
- 計測方法を固定しました。**ウォームアップを除く定常値**は次のコマンドで測ります（最初の8シード/ワーカーとワーカー起動を除外し、最も遅いワーカーの実時間で割る）。
  ```sh
  node tools/bench-throughput.js --seeds 128 --warmup 8 --workers 4
  ```
  標準設定は **65.6 games/s**、`--level fast`（根12）は **66.8 games/s**（同一policyのduplicate）。128シードの起動込みでも63.2 games/s、ウォームアップ区間は52.6 games/sでした。16シードだと定常推定が57.6 games/s、起動込み47.3 games/sとぶれます。**16局と128局の差（42.5 vs 56.2）は、ワーカー起動・モジュール読込・向聴/形キャッシュとJITのウォームアップ**が主因で、定常値そのものはほぼ同じです。比較には128シード以上を使ってください。
- **2026-11-23の再プロファイル**: `node --cpu-prof tools/profile-run.js {fast|standard} 6` で24局を計測。fast/standardとも **2.06秒** で差は再現せず、CPU self timeの上位は `finish`（評価器）8.3/10.9%、`agari.decompose` 6.7/6.9%、観測生成5.6/4.7%、`Game.waits` 4.4/5.1%、`evaluate` 4.4/5.2%、向聴の`groupOptions`/`combineGroups` 7.8/6.0%、`Game.discard` 4.1/3.9%、`clone`+`record` 7.2/6.6%でした。律速は根候補数ではなく **評価器・和了分解・観測生成・フリテン/待ち・向聴・記録clone** の共通処理です。**fastは互換・小規模比較用に残しますが、速度レバーではありません**。集計は `tools/profile-cpu.js`、結果は `test-results/profile-fast.json` / `profile-standard.json`。
- 旧8.5 games/s（16局、起動込み）→ 同じ16局コマンドで38.6–42.5 games/s（4.5–5.0倍）、定常65.6 games/s。fast（根12）は標準との打牌一致率98.6%、`--root-candidates 5` はさらに速いが一致率51%です。
- 数値は `test-results/bench-steady-128.json` / `bench-steady-fast-128.json` / `bench-steady-16.json` / `divergence-k12.json` に保存しています。CPU・ワーカー数・シード数で変動します。

## 効果音・Voicepeak発声

画面上部の「効果音」でON/OFFできます。打牌は短い牌音、リーチ・副露・和了は音程の異なる効果音です。最初のクリック後から鳴ります。

「発声WAV」から `riichi.wav`, `pon.wav`, `chi.wav`, `kan.wav`, `ron.wav`, `tsumo.wav` を複数選択すると該当する発声に置き換わります。日本語の `リーチ.wav`, `ポン.wav`, `チー.wav`, `カン.wav`, `ロン.wav`, `ツモ.wav` でも構いません。各10MB以内、前後の無音が短い音声が使いやすいです。音声はローカルで読み込み、現在のタブ内で保持します。

右側の「直前の打牌に検討メモ」で、その打牌にメモを付けられます。違和感のある打牌を報告するときは、**JSON牌譜、局番号（#）、イベント番号（#）、気になった点**を添えてください。対局途中の書き出しも可能です。

JSONには以下を保存します。

- 局開始時に確定した136枚の全牌山・配牌・開始点数
- ツモ、打牌の物理牌ID、`tsumogiri`、`riichi`、イベント番号
- 副露、槓、ドラ表示、見逃しを含む応答、和了・流局結果
- AIの打牌候補ごとの向聴数、受入、危険度、評価値、先読み受入
- 検討メモ

牌IDは `牌種 × 4 + コピー番号`、牌種は萬子0–8・筒子9–17・索子18–26・東南西北白發中27–33です。赤牌IDは16・52・88です。JSONは翠卓独自形式で、天鳳・雀魂形式との互換はありません。

局終了時の牌譜はブラウザーのローカルストレージにも保存され、次回開始画面から検討できます。継続プレイのセーブではありません。保存容量やブラウザー設定に制限があるため、残したい牌譜はJSONで保存してください。

## 漏えい監査

`test/leak.test.js` と `test/ui.test.js` で、対局中に公開されてはいけない情報を検査します。

- 対局中の `MJ.ui.record` と localStorage / 書き出しJSONには、牌山（`wall`）・他家の配牌（`initialHands`）・他家のツモ牌（`draw.tileId`）・他家の応答候補（`response.options`）・他家AIの解析（`discard.analysis`）が含まれません。
- 暗槓の伏せ牌にある赤5は、対局中も記録・表示・マスク済みJSONで公開しません。
- 応答チェックの待ち時間は、各家に合法な鳴き/ロンがあるかどうかで変わりません（`Game#checkCalls` の `onCheck`）。待ち時間の定数は `src/pacing.js` に集約しています。
- **「高速進行」ON でも**、`MJ.pacing.checkDelay(true)` は全席0ms、`agentDelay` / `agentBudget` も合法手の有無に依存しません。合法ロンがある席とない席で同じ遅延がスケジュールされることを `test/leak.test.js` で確認します。
- **ロン見逃し（フリテン）** で情報が漏れないことも確認します。見逃した席の `tempFuriten` は立ちますが、他家の公開観測ビュー・ログ・マスク済み牌譜には現れません。見逃しの応答イベントはマスク時に他家分が削除されます。
- `src/` に `console.log` / `console.debug` / `console.info` はありません。`#log`（aria-live）・トースト・コンソールに他家の手牌名が出ないことをテストします。
- 終局後は `MJ.ui.record` と保存JSONが全情報を含みます。マスク済みJSONは再検討できません（`redacted: true`）。

## 開発・検証

```sh
npm install
npx playwright install chromium
npm test            # 高速スイート: 全ユニット + selfplay 60局 + 最小ブラウザー
npm run test:full   # selfplay 300局 + 全ブラウザーテスト（CIのnightly）
npm run build
```

- `npm test` は日常用です。`test/ui.test.js --fast` は初期描画・伏せ牌・河配置・レスポンシブだけを確認します。
- `npm run test:full` は半荘を最後まで自動進行し、書き出し・読み込み・検討・mjai変換まで確認します。CIでは毎日18:00 UTCに実行します。
- 評価の高速化・開始状態・GRP比較は `npm run evaluate:fast` / `npm run start-states` と上記の `tools/evaluate.js` オプションを使います。

### Rust core の検証

`rust/` は JS core の移植です。初回は rustup を入れてから実行します。

```sh
rustup toolchain install stable --component rustfmt clippy
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml
```

rustup を入れられない環境では Docker でも同じ検査ができます。

```sh
docker run --rm -v "$PWD/rust:/app" -w /app rust:latest   bash -lc "rustup component add rustfmt clippy && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test"
```

`rust/Cargo.lock` は再現性のためコミットします。`rust/tests/golden/shanten.json` は、新テーブル実装と旧DFSの等価性を `SHANTEN_CASES=100000 node test/shanten.test.js`（10万件、副露あり、不一致0）で確認した**後**のJS実装から生成した5,000手の golden です。向聴・和了判定の一致を検査します。**ゲーム進行のイベント列リプレイは実装済み**です。`test/golden/core-*.json` は `decisions`（席・種別・合法手）・`wall`・`initialHands` を含み、`rust/tests/replay.rs` が4ファイル合計497イベントの完全一致を確認します（`cargo test`）。役・点数ペイロードは既存の向聴/和了/点数goldenで担保し、リプレイでは進行identityを比較します。PyO3は既定offの `python` featureで `replay_golden(json) -> str` を公開する骨組みまで用意しています。

`index.html` が開発用、`mahjong.html` がフォント・CSS・JSを埋め込んだ配布用です。

### 自己学習（重みチューニング）

`train.js` は自己対戦で評価関数の重みを進化戦略で調整します（外部依存なし、Node CLI）。

```sh
npm run train -- --hands 160 --iters 20 --workers 8
node train.js --eval weights.json --hands 240
```

- 候補の重みを1席ずつ交代で担当させ、残りの3席は既定AIが打ちます。全候補が同一の牌山シードで対戦するため、候補間の比較がぶれにくくなります。
- 出力 `weights.json` は開始画面の「学習済みのAI重みを読み込む」から読み込めます。
- `--level standard`（既定）は高速です。`--level strong` は1局あたり十数秒かかるため小規模向けです。
- 目的関数は候補席の平均最終点数です。局数が少ないと特定の牌山に過適合するので、`--hands` を増やし、最後に `--eval` で別シードを確認してください。
- 主なオプションは `node train.js --help` を参照してください。

テストは向聴（スート表とDFSの一致）・点数の回帰確認、王牌・フリテン・対局進行のルール確認、観測ビューの公開情報（他家の手牌ID・牌山・裏ドラを含まないこと、暗槓の赤非公開）、対局中牌譜のマスクと固定応答待ち時間（高速進行ON・ロン見逃しを含む）、core APIのgolden再現・決定性・136枚保存則、順位点と順位点EV、GRPの試合単位分割・24順列の行列入力和・モデル読み込み、mjai双方向変換・天鳳mjlogリプレイ・ルール差フラグ・牌山配置・座席視点マスク、特徴量の非漏えい・ラベル・JSONL、duplicate評価のhandicapクラスタ・開始状態・検出力・決定性・候補席モード・fast設定、受入牌リストの全34種一致、シード固定のAI対戦（点数・136枚の保存則・牌譜再生一致）、Chromiumによる実ブラウザー操作（画面幅・フォント・河配置・伏せ牌の非漏えい・新規対局・対局終了・書き出し／読み込み）を実行します。`npm test` は高速版、`npm run test:full` は完全版です。

## 未着手・今後の作業

- Rust coreは `tiles`・`shanten`（標準形／七対子／国士）・`agari`・基本`score` に加え、**golden操作列のイベント列リプレイ**とRNG/牌山再現を実装しました。`cargo test` で向聴・和了判定の5,000手goldenと、4ファイル497イベントの完全一致を確認します。PyO3バインディングはfeature-gatedの骨組みまでです。次はゲームループ全体のRust移植と自己対戦エンジンの移設です。
- 天鳳一括パイプラインと取得ツール（`tools/tenhou-fetch.js`）を実装しました。1万半荘規模の実データは同梱していません。変換失敗率・除外率は各自のデータで `--out-report` を確認してください。
- 教師あり方策（ResNet打牌／リーチ／鳴き／和了ヘッド）、ONNX → `onnxruntime-node` の学習型COM、`--candidate-policy` によるduplicate比較まで実装しました。データ規模が小さいため、強さの主張には追加の天鳳牌譜とduplicate評価が必要です。ブラウザー向け `onnxruntime-web` のUI選択は未着手です。
- GRPのブラウザー推論（`onnxruntime-web`）は未着手です。`grp.json` の推論器はJavaScriptで動作します。
- 自己対戦強化学習（PPO＋相手プール）、雀魂牌譜の直接変換は未着手です（雀魂は利用規約の確認後、優先度低）。
- `--level fast` は根12で標準とほぼ一致しますが、2026-11-23の再プロファイルでは標準との速度差がありませんでした（24局とも2.06秒）。fastは互換・小規模比較用に残し、高速化は評価器・観測生成・向聴・記録cloneの共通ホットスポットで行います。

### フォント

[GL-MahjongTile / Gutenberg Labo](https://github.com/Gutenberg-Labo/DingbatFonts)

ライセンスは `assets/LICENSE-GL-MahjongTile.txt` に同梱し、単体HTMLにも含めています。
