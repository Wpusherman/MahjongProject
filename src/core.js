(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = MJ.tiles;
  const C = (MJ.core = { version: 'core-0.1' });

  // Deterministic PRNG used when a wall is not supplied.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedToUint(seed) {
    if (Number.isFinite(seed)) return seed >>> 0;
    const text = String(seed == null ? 0 : seed);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  C.rng = function (seed) { return mulberry32(seedToUint(seed)); };

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pass = () => ({ type: 'pass' });
  const isPass = (action) => action == null || action === false || (typeof action === 'object' && action.type === 'pass');

  function normalizeConfig(config) {
    return Object.assign({ roundWind: 27, dealer: 0, honba: 0, riichiSticks: 0,
      scores: [25000, 25000, 25000, 25000] }, config || {});
  }

  function Core(config, seed) {
    this.config = normalizeConfig(config);
    this.seed = seed;
    this.rng = C.rng(seed);
    this.wall = this.config.wall ? this.config.wall.slice() : T.buildWall(this.rng);
    this.game = null;
    this.pending = null;
    this.result = null;
    this.done = false;
    this.error = null;
    this._resolve = null;
    this._ready = null;
    this._cursor = 0;
    this._loop = null;
    this._started = false;
  }

  const discardActions = (core, view) => {
    if (view.riichi) return view.drawnTile == null ? [] : [{ type: 'discard', tileId: view.drawnTile, riichi: false }];
    const out = [], seen = new Set();
    for (const tileId of view.legalDiscards || view.hand || []) {
      if (seen.has(tileId)) continue;
      seen.add(tileId);
      out.push({ type: 'discard', tileId, riichi: false });
      if (view.canRiichi && core.game.waits(view.seat, view.hand.filter((id) => id !== tileId)).length > 0) {
        out.push({ type: 'discard', tileId, riichi: true });
      }
    }
    return out;
  };
  const callActions = (options) => {
    const out = [];
    if (options.ron) out.push({ type: 'ron' });
    if (options.pon != null) out.push({ type: 'pon', tile: options.tile });
    if (options.kan != null) out.push({ type: 'kan', tile: options.tile });
    for (const pair of options.chi || []) out.push({ type: 'chi', tile: options.tile, tiles: pair.slice() });
    out.push(pass());
    return out;
  };
  const kanActions = (kans) => kans.map((k) => ({ type: 'kan', kan: { kind: k.kind, tile: k.tile } })).concat([pass()]);

  Core.prototype._agent = function (seat) {
    const core = this;
    return {
      lastCallAnalysis: null,
      wantTsumo(view) {
        core._pend(seat, 'tsumo', view, [{ type: 'tsumo' }, pass()]);
        return core._deferred();
      },
      chooseDiscard(view) {
        core._pend(seat, 'discard', view, discardActions(core, view));
        return core._deferred();
      },
      wantCall(view, options) {
        this.lastCallAnalysis = null;
        if (!options) return Promise.resolve(null);
        core._pend(seat, 'call', view, callActions(options));
        return core._deferred();
      },
      wantKan(view, kans) {
        core._pend(seat, 'kan', view, kanActions(kans));
        return core._deferred();
      }
    };
  };

  Core.prototype._pend = function (seat, type, view, legal) {
    if (this.pending) throw new Error('A decision is already pending');
    this.pending = { seat, type, view, legal };
    this._signal();
  };
  Core.prototype._deferred = function () {
    if (this._resolve) throw new Error('A decision is already waiting');
    return new Promise((resolve) => { this._resolve = resolve; });
  };
  Core.prototype._signal = function () {
    const ready = this._ready;
    if (ready) { this._ready = null; ready(); }
  };
  Core.prototype._waitReady = function () {
    if (this.pending || this.done) return Promise.resolve();
    return new Promise((resolve) => { this._ready = resolve; });
  };
  Core.prototype._drain = function () {
    const all = this.game.recording.events;
    const events = all.slice(this._cursor).map(clone);
    this._cursor = all.length;
    return events;
  };

  Core.prototype.start = async function () {
    if (this._started) throw new Error('Game already started');
    this._started = true;
    const agents = [0, 1, 2, 3].map((seat) => this._agent(seat));
    this.game = new MJ.Game({ agents, rng: this.rng });
    this._loop = this.game.playHand(Object.assign({}, this.config, { wall: this.wall }))
      .then((result) => { this.result = result; this.done = true; this.pending = null; this._signal(); },
        (error) => { this.error = error; this.done = true; this._signal(); });
    await this._waitReady();
    if (this.error) throw this.error;
    return this._drain();
  };

  Core.prototype.current = function () {
    if (!this.pending) return null;
    return { seat: this.pending.seat, type: this.pending.type, legal: this.pending.legal.map(clone) };
  };
  Core.prototype.legal_actions = function (seat) {
    if (!this.pending) return [];
    if (seat != null && seat !== this.pending.seat) return [];
    return this.pending.legal.map(clone);
  };
  Core.prototype.observe = function (seat) {
    if (!this.game) throw new Error('Game has not started');
    if (this.pending && this.pending.seat === seat) return this.pending.view;
    return this.game.getObservation(seat);
  };
  Core.prototype.is_terminal = function () { return this.done; };
  Core.prototype.final_result = function () { return this.result; };

  Core.prototype._validate = function (pending, action) {
    if (pending.type === 'discard') {
      const a = typeof action === 'number' ? { type: 'discard', tileId: action, riichi: false } : action;
      if (!a || (a.type && a.type !== 'discard') || !Number.isInteger(a.tileId)) throw new Error('Illegal discard action');
      const riichi = !!a.riichi;
      const legal = pending.legal.some((x) => x.type === 'discard' && x.tileId === a.tileId && x.riichi === riichi);
      if (!legal) throw new Error(`Illegal discard: tile ${a.tileId}${riichi ? ' with riichi' : ''}`);
      return { tileId: a.tileId, riichi, analysis: a.analysis || null };
    }
    if (pending.type === 'tsumo') return action === true || (action && action.type === 'tsumo');
    if (pending.type === 'kan') {
      if (isPass(action)) return null;
      const kan = action.kan || action;
      const legal = pending.legal.find((x) => x.type === 'kan' && x.kan.kind === kan.kind && x.kan.tile === kan.tile);
      if (!legal) throw new Error('Illegal kan action');
      return legal.kan;
    }
    if (pending.type === 'call') {
      if (isPass(action)) return null;
      const legal = pending.legal.find((x) => x.type === action.type &&
        (action.type === 'ron' || (x.tile === action.tile && (action.type !== 'chi' || JSON.stringify(x.tiles) === JSON.stringify(action.tiles)))));
      if (!legal) throw new Error('Illegal call action');
      return legal;
    }
    throw new Error('Unknown pending decision: ' + pending.type);
  };

  Core.prototype.step = async function (action) {
    if (this.done) throw new Error('Game is terminal');
    const pending = this.pending;
    if (!pending) throw new Error('No pending decision');
    const decision = this._validate(pending, action);
    const resolve = this._resolve;
    if (!resolve) throw new Error('No waiting agent');
    this.pending = null;
    this._resolve = null;
    resolve(decision);
    await this._waitReady();
    if (this.error) throw this.error;
    return this._drain();
  };

  C.Core = Core;
  C.create = function (config, seed) { return new Core(config, seed); };
  C.new_game = async function (config, seed) {
    const core = new Core(config, seed);
    await core.start();
    return core;
  };
  C.newGame = C.new_game;
})();
