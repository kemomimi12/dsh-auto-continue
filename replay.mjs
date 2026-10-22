// Replay the real 2026-10-21 outage through the plugin's decision logic.
//
// The key detail the first replay missed: in the real log, turn 7 emitted 106
// assistant/message events INTERLEAVED with the tool calls, and the SERVER
// failure came at the very end. Under the old code every one of those events
// reset the streak to 0, so the failure at the end of turn 7 counted as #1.
// Then turns 8/9/10 each had zero assistant messages, so the streak climbed
// 1,2,3,4 — and the old build stopped only when it crossed the limit.
//
// This replay models both builds against the true event ordering.
import { apply } from './index.js';

// True shape from the live log: [turn, endReason, assistantMessagesInTurn]
const realTurns = [
  { turn: 7, kind: 'error', code: 'SERVER', assistantMessages: 106 },
  { turn: 8, kind: 'error', code: 'STREAM_CLOSED', assistantMessages: 0 },
  { turn: 9, kind: 'error', code: 'SERVER', assistantMessages: 0 },
  { turn: 10, kind: 'error', code: 'SERVER', assistantMessages: 0 },
  { turn: 11, kind: 'error', code: 'SERVER', assistantMessages: 0 },
];

async function run(config) {
  const listeners = new Map();
  const agents = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    effect(factory) { ctx._disposers.push(factory()); },
    _disposers: [],
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    get: () => undefined,
  };
  apply(ctx, config);

  const agent = {
    id: 'replay',
    status: 'running',
    session: { id: 'replay', header: { id: 'replay' } },
    inbox: { nextTurn: [], nextStep: [] },
    followed: [],
    followup(m) { this.followed.push(m); this.inbox.nextTurn.push(m); },
  };
  agent.inbox.remove = (id) => {
    const i = agent.inbox.nextTurn.findIndex((m) => m.id === id);
    if (i >= 0) { agent.inbox.nextTurn.splice(i, 1); return true; }
    return false;
  };
  agents.set('replay', agent);

  const emit = (event) => {
    for (const fn of listeners.get('session/event') ?? []) fn(agent.session, event);
  };

  const decisions = [];
  for (const t of realTurns) {
    // Interleave assistant output the way the real turn did.
    for (let i = 0; i < t.assistantMessages; i++) {
      emit({ type: 'assistant/message', data: {} });
    }
    emit({
      type: 'turn/end',
      data: { turn: t.turn, reason: { kind: 'error', error: { code: t.code, message: 'down' } } },
    });
    agent.status = 'idle';
    const before = agent.followed.length;
    await new Promise((r) => setImmediate(r));
    const resumed = agent.followed.length > before;
    decisions.push({ turn: t.turn, code: t.code, resumed });
    // A resume would have been admitted; model that so the next failure counts
    // against a resume the plugin actually spent.
    if (resumed) {
      const queued = agent.inbox.nextTurn[0];
      emit({ type: 'user/message', data: queued });
    }
    agent.inbox.nextTurn.length = 0;
    agent.status = 'running';
  }
  return { decisions, total: agent.followed.length };
}

const fixed = await run({ maxConsecutiveFailures: 3, maxResumesPerWindow: 5 });
const fmt = (r) => r.decisions
  .map((d) => `  turn ${String(d.turn).padStart(2)} ${d.code.padEnd(14)} ${d.resumed ? 'RESUME' : 'stand down'}`)
  .join('\n');

console.log('=== FIXED build, replayed against the real outage shape ===');
console.log(fmt(fixed));
console.log(`  total resumes: ${fixed.total}`);

// Expected: turn 7 is a SERVER storm's first failure -> one resume. Turn 8 is a
// different code (STREAM_CLOSED) -> new storm -> one resume. Turns 9-11 are
// SERVER again but the storm window has expired, so each would normally reopen;
// the consecutive-failure ceiling is what stops it here. Either way the plugin
// must go quiet well before the old build's 5 resumes.
const expected = 2;
const ok = fixed.total === expected;
console.log(ok
  ? `\nPASS  stands down early (${fixed.total} resumes, then silent)`
  : `\nFAIL  expected ${expected} resumes, got ${fixed.total}`);
process.exit(ok ? 0 : 1);
