(function () {
  const sounds = globalThis.MJ.audio = { enabled: true, context: null, voices: new Map() };
  const names = { riichi: 'リーチ', pon: 'ポン', chi: 'チー', kan: 'カン', ron: 'ロン', tsumo: 'ツモ' };
  sounds.unlock = function () {
    if (!this.enabled) return;
    try {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) return;
      if (!this.context) this.context = new Context();
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch (_) {}
  };
  sounds.load = async function (files) {
    this.unlock();
    if (!this.context) throw new Error('このブラウザーでは音声を再生できません');
    let loaded = 0;
    for (const file of files) {
      const stem = file.name.replace(/\.wav$/i, '').toLowerCase();
      const key = Object.keys(names).find((k) => k === stem || names[k] === stem);
      if (!key || file.size > 10 * 1024 * 1024) continue;
      const buffer = await this.context.decodeAudioData(await file.arrayBuffer());
      this.voices.set(key, buffer); loaded++;
    }
    return loaded;
  };
  sounds.play = function (kind) {
    if (!this.enabled || !this.context || this.context.state !== 'running') return;
    const ctx = this.context, time = ctx.currentTime;
    const voice = this.voices.get(kind);
    if (voice) {
      const source = ctx.createBufferSource(), gain = ctx.createGain();
      source.buffer = voice; gain.gain.value = 0.65; source.connect(gain); gain.connect(ctx.destination);
      source.onended = () => { source.disconnect(); gain.disconnect(); }; source.start(); return;
    }
    const notes = kind === 'discard' ? [800] : kind === 'riichi' ? [523, 784, 1046] : ['ron', 'tsumo'].includes(kind) ? [523, 659, 784, 1046] : ['pon', 'chi', 'kan'].includes(kind) ? [660, 880] : [];
    notes.forEach((hz, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain(), start = time + i * 0.085;
      const length = kind === 'discard' ? 0.035 : 0.16;
      osc.type = kind === 'discard' ? 'triangle' : 'sine'; osc.frequency.setValueAtTime(hz, start);
      if (kind === 'discard') osc.frequency.exponentialRampToValueAtTime(210, start + length);
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(kind === 'discard' ? 0.045 : 0.075, start + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain); gain.connect(ctx.destination); osc.start(start); osc.stop(start + length + 0.01);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    });
  };
})();
