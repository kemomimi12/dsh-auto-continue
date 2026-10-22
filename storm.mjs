// Show what storm merging changes, using the 2026-10-21 outage shape.
//
// The real incident: the gateway answered 503 SERVER to every request for over
// a minute. Every turn failed with the SAME code. Without merging, each failed
// turn looked like a fresh incident and bought its own resume.
import { apply } from './index.js';

// Turn-by-turn from the live log: same code (SERVER) repeating.
const stormTurns = [
  { turn: 7, code: 'SERVER' },
  { turn: 8, code: 'SERVER' },
  { turn: 9, code: 'SERVER' },
  { turn: 10, code: 'SERVER' },
  { turn: 11, code: 'SERVER' },
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
  const emit = (e) => { for (const fn of listeners.get('session/event') ?? []) fn(agent.session, e); };

  const decisions = [];
  for (const t of stormTurns) {
    emit({ type: 'turn/end', data: { turn: t.turn, reason: { kind: 'error', error: { code: t.code, message: 'Service temporarily unavailable' } } } });
    agent.status = 'idle';
    const before = agent.followed.length;
    await new Promise((r) => setImmediate(r));
    const resumed = agent.followed.length > before;
    decisions.push({ turn: t.turn, code: t.code, resumed });
    if (resumed) emit({ type: 'user/message', data: agent.inbox.nextTurn[0] });
    agent.inbox.nextTurn.length = 0;
    agent.status = 'running';
  }
  return { decisions, total: agent.followed.length };
}

// Isolate storm merging: a high consecutive ceiling and a large window budget so
// only the storm rule can stop it.
const base = { maxConsecutiveFailures: 99, maxResumesPerWindow: 99 };

const without = await run({ ...base, maxResumesPerStorm: 99 });
const withStorm = await run({ ...base, maxResumesPerStorm: 1 });

const fmt = (r, label) => `${label}\n` + r.decisions
  .map((d) => `  turn ${String(d.turn).padStart(2)} ${d.code.padEnd(10)} ${d.resumed ? 'RESUME' : 'stand down'}`)
  .join('\n') + `\n  total resumes: ${r.total}`;

console.log(fmt(without, '=== WITHOUT storm merging (maxResumesPerStorm: 99) ==='));
console.log('');
console.log(fmt(withStorm, '=== WITH storm merging (maxResumesPerStorm: 1) ==='));
console.log('');

const ok = without.total === 5 && withStorm.total === 1;
console.log(ok
  ? `PASS  one outage now costs ${withStorm.total} resume instead of ${without.total}`
  : `FAIL  without=${without.total} with=${withStorm.total}`);
process.exit(ok ? 0 : 1);
