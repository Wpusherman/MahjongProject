(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  // Fixed UI pacing. Every delay depends only on the "fast" setting and the
  // kind of decision, never on whether a call/ron is actually available. Keeping
  // the constants here lets the leak tests assert that property directly.
  MJ.pacing = {
    version: 'pacing-v1',
    checkDelay(fast) { return fast ? 0 : 45; },
    autoDiscardDelay(fast) { return fast ? 0 : 420; },
    agentDelay(fast, fn) { return fast ? 0 : fn === 'chooseDiscard' ? 400 : 100; },
    agentBudget(fast, fn) { return fast ? 0 : fn === 'chooseDiscard' ? 400 : 120; }
  };
})();
