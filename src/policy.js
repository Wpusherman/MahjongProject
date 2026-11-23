(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const P = (MJ.policy = { version: 'policy-v1' });

  // onnxruntime-node is optional: the browser build ships its own runtime and
  // the heuristic AI must keep working without an ONNX model.
  P.available = function () {
    try { require.resolve('onnxruntime-node'); return true; } catch (_) { return false; }
  };
  P.load = async function (file) {
    if (!P.available()) throw new Error('onnxruntime-node is not installed');
    const ort = require('onnxruntime-node');
    const session = await ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
    // Training used inverse-frequency class weights. They change the learned
    // distribution to p*w, so inference subtracts log(w) to recover p.
    let meta = null;
    try {
      const fs = require('node:fs');
      meta = JSON.parse(fs.readFileSync(file.replace(/\.onnx$/i, '.json'), 'utf8'));
    } catch (_) { meta = null; }
    const priors = meta && meta.classWeights ? meta.classWeights : null;
    return { file, session, ort, inputNames: session.inputNames, outputNames: session.outputNames,
      priors, meta,
      shape: MJ.features && MJ.features.CHANNELS ? { channels: MJ.features.CHANNELS.length, globals: MJ.features.GLOBAL_NAMES.length } : null };
  };

  function encodeBatch(views) {
    if (!views.length) throw new Error('policy.predictBatch requires observations');
    const first = MJ.features.encode(views[0]);
    const channels = first.shape.channels, tiles = first.shape.tiles, globals = first.shape.globals;
    const n = views.length;
    const tileData = new Float32Array(n * channels * tiles);
    const globalData = new Float32Array(n * globals);
    for (let i = 0; i < n; i++) {
      const encoded = i === 0 ? first : MJ.features.encode(views[i]);
      tileData.set(encoded.data.subarray(0, channels * tiles), i * channels * tiles);
      globalData.set(encoded.data.subarray(channels * tiles, channels * tiles + globals), i * globals);
    }
    return { tileData, globalData, n, channels, tiles, globals };
  }

  // Batched inference. `views` are public observations (never hidden hands/wall).
  P.predictBatch = async function (model, views) {
    if (!model || !model.session) throw new Error('policy model is not loaded');
    const encoded = encodeBatch(views);
    const { ort, session } = model;
    const feeds = {
      tiles: new ort.Tensor('float32', encoded.tileData, [encoded.n, encoded.channels, encoded.tiles]),
      globals: new ort.Tensor('float32', encoded.globalData, [encoded.n, encoded.globals])
    };
    const started = Date.now();
    const result = await session.run(feeds);
    return {
      batch: encoded.n, elapsedMs: Date.now() - started,
      discard: result.discard.data, riichi: result.riichi.data,
      call: result.call.data, win: result.win.data,
      shape: { discard: 34, riichi: 2, call: 5, win: 2 }
    };
  };

  const slice = (data, offset, length) => Array.prototype.slice.call(data, offset, offset + length);
  P.predict = async function (model, view) {
    const out = await P.predictBatch(model, [view]);
    return {
      discard: slice(out.discard, 0, 34), riichi: slice(out.riichi, 0, 2),
      call: slice(out.call, 0, 5), win: slice(out.win, 0, 2), elapsedMs: out.elapsedMs
    };
  };

  const argmax = (values, legal) => {
    let best = -Infinity, index = -1;
    for (let i = 0; i < values.length; i++) {
      if (legal && !legal[i]) continue;
      if (values[i] > best) { best = values[i]; index = i; }
    }
    return index;
  };
  const debias = (values, weights) => {
    if (!weights) return Array.prototype.slice.call(values);
    return Array.prototype.map.call(values, (value, i) => value - Math.log(Math.max(1e-6, weights[i] || 1)));
  };

  // Policy decision helpers. The game still validates every action; these only
  // rank the legal actions of the current observation.
  P.chooseDiscard = async function (model, view) {
    const out = await P.predict(model, view);
    const legal = new Array(34).fill(false);
    for (const id of view.legalDiscards || view.hand || []) {
      const t = id >> 2;
      if (!(view.forbidden || []).includes(t)) legal[t] = true;
    }
    const tile = argmax(out.discard, legal);
    if (tile < 0) return null;
    const riichiLogits = debias(out.riichi, model.priors && model.priors.riichi);
    const riichi = !!view.canRiichi && riichiLogits[1] > riichiLogits[0];
    return { tile, riichi, probabilities: out };
  };

  P.chooseCall = async function (model, view, opts) {
    if (!opts) return null;
    const out = await P.predict(model, view);
    const scores = debias(out.call, model.priors && model.priors.call);
    const legal = [true, !!(opts.chi || []).length, opts.pon != null, opts.kan != null, !!opts.ron];
    const index = argmax(scores, legal);
    // A call must beat pass by a small margin; otherwise the policy passes.
    if (index <= 0 || scores[index] <= scores[0] + (model.callMargin == null ? 0.25 : model.callMargin)) return null;
    if (index === 1) return { type: 'chi', tile: opts.tile, tiles: opts.chi[0].slice() };
    if (index === 2) return { type: 'pon', tile: opts.pon };
    if (index === 3) return { type: 'kan', tile: opts.kan };
    return { type: 'ron' };
  };

  P.chooseTsumo = async function (model, view) {
    const out = await P.predict(model, view);
    const win = debias(out.win, model.priors && model.priors.win);
    return win[1] >= win[0];
  };
})();
