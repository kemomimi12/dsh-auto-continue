// Prove the fix by driving the plugin's real observe() through the exact event
// stream the live session produced, and reading the decision it makes.
//
// The old build differed in one branch only: every `assistant/message` reset the
// failure streak to 0. Rather than fake that with a synthetic completed turn
// (which the fixed build also treats as a reset), this harness loads the
// pre-fix source, runs both, and diffs the resume decisions.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SOURCE = new URL('./index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const original = readFileSync(SOURCE, 'utf8');

// Reconstruct the pre-fix branch by reverting the three edits.
const legacySource = original
  .replace(
    /case 'assistant\/message':[\s\S]*?return;/,
    "case 'assistant/message':\n        state.consecutive = 0;\n        return;",
  )
  .replace(/if \(state\.consecutive > maxConsecutiveFailures\) \{/, 'if (state.consecutive >= maxConsecutiveFailures) {');

const dir = mkdtempSync(join(tmpdir(), 'ac-cmp-'));
const legacyFile = join(dir, 'legacy.mjs');
writeFileSync(legacyFile, legacySource, 'utf8');

const { apply: applyFixed } = await import(new URL('./index.js', import.meta.url).href);
const { apply: applyLegacy } = await import(`file:///${legacyFile.replace(/\\/g, '/')}`);

// The real outage shape: turn 7 emitted 106 assistant messages, then failed.
const realTurns = [
  { turn: 7, code: 'SERVER', assistantMessages: 106 },
  { turn: 8, code: 'STREAM_CLOSED', assistantMessages: 0 },
  { turn: 9, code: 'SERVER', assistantMessages: 0 },
  { turn: 10, code: 'SERVER', assistantMessages: 0 },
  { turn: 11, code: 'SERVER', assistantMessages: 0 },
];

async function run(applyFn, config) {
  const listeners = new Map();
  const agents = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    effect(factory) { ctx._disposers.push(factory()); },
    _disposers: [],
    agents: { get: (id) => agents.get(id) },
    get: () => undefined,
  };
  applyFn(ctx, config);

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
  for (const t of realTurns) {
    for (let i = 0; i < t.assistantMessages; i++) emit({ type: 'assistant/message', data: {} });
    emit({ type: 'turn/end', data: { turn: t.turn, reason: { kind: 'error', error: { code: t.code, message: 'down' } } } });
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

const cfg = { maxConsecutiveFailures: 3, maxResumesPerWindow: 5 };
const legacy = await run(applyLegacy, cfg);
const fixed = await run(applyFixed, cfg);

const fmt = (r, label) => `${label}\n` + r.decisions
  .map((d) => `  turn ${String(d.turn).padStart(2)} ${d.code.padEnd(14)} ${d.resumed ? 'RESUME' : 'stand down'}`)
  .join('\n') + `\n  total: ${r.total}`;

console.log(fmt(legacy, '=== PRE-FIX build (streak wiped by assistant output) ==='));
console.log('');
console.log(fmt(fixed, '=== FIXED build ==='));
console.log('');

const ok = legacy.total > fixed.total && fixed.total === 3;
console.log(ok
  ? `PASS  fix removes ${legacy.total - fixed.total} wasted resume(s): ${legacy.total} -> ${fixed.total}`
  : `FAIL  legacy=${legacy.total} fixed=${fixed.total}`);
process.exit(ok ? 0 : 1);
