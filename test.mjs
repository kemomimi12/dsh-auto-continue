// Behavioural test for @local/dsh-auto-continue against a fake host.
// Run: node test.mjs
import { apply, name, inject } from './index.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

function makeHost(config) {
  const listeners = new Map();
  const logs = [];
  const agents = new Map();
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return () => {
        const list = listeners.get(event) ?? [];
        const i = list.indexOf(listener);
        if (i >= 0) list.splice(i, 1);
      };
    },
    effect(factory) {
      const disposer = factory();
      ctx._disposers.push(disposer);
    },
    _disposers: [],
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    },
    get: () => undefined,
  };
  apply(ctx, config);

  function emit(event, ...args) {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  }
  function addAgent(id, { origin } = {}) {
    const inbox = { nextTurn: [], nextStep: [] };
    const agent = {
      id,
      status: 'running',
      session: { id, header: origin === undefined ? { id } : { id, origin } },
      inbox,
      followed: [],
      followup(message) {
        this.followed.push(message);
        inbox.nextTurn.push(message);
      },
    };
    agent.inbox.remove = (messageId) => {
      const i = inbox.nextTurn.findIndex((m) => m.id === messageId);
      if (i < 0) return false;
      inbox.nextTurn.splice(i, 1);
      return true;
    };
    agents.set(id, agent);
    return agent;
  }
  return { ctx, emit, addAgent, logs, agents, listeners };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function turnEndError(failure) {
  return { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: failure } } };
}

// 1. A transient failure queues exactly one resume prompt.
{
  const host = makeHost({});
  const agent = host.addAgent('s1');
  host.emit('session/event', agent.session, turnEndError({ code: 'TRANSPORT', message: 'boom' }));
  agent.status = 'idle';
  await flush();
  check('transient failure queues one resume', agent.followed.length, 1);
  check('resume prompt is tagged', agent.followed[0]?.source?.kind, 'auto-continue');
  check('resume prompt is a user message', agent.followed[0]?.role, 'user');
  check('resume prompt names the code', agent.followed[0]?.content?.[0]?.text?.includes('TRANSPORT'), true);
}

// 2. A permanent failure never resumes.
{
  const host = makeHost({});
  const agent = host.addAgent('s2');
  host.emit('session/event', agent.session, turnEndError({ code: 'AUTH', message: 'no access' }));
  agent.status = 'idle';
  await flush();
  check('AUTH does not resume', agent.followed.length, 0);
}

// 3. A manual stop (aborted turn) never resumes.
{
  const host = makeHost({});
  const agent = host.addAgent('s3');
  host.emit('session/event', agent.session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  });
  agent.status = 'idle';
  await flush();
  check('user abort does not resume', agent.followed.length, 0);
}

// 4. A human message retracts a resume still waiting in the inbox.
{
  const host = makeHost({});
  const agent = host.addAgent('s4');
  host.emit('session/event', agent.session, turnEndError({ code: 'STREAM_CLOSED', message: 'cut' }));
  agent.status = 'idle';
  await flush();
  check('resume queued before the human types', agent.inbox.nextTurn.length, 1);
  host.emit('session/event', agent.session, {
    type: 'user/message',
    data: { id: 'human-1', role: 'user', content: [{ type: 'text', text: 'stop that' }], source: { kind: 'user' } },
  });
  await flush();
  check('human message retracts the pending resume', agent.inbox.nextTurn.length, 0);
}

// 5. Consecutive failures stop after the configured limit.
//    `maxConsecutiveFailures: 2` means "stand down once 2 turns in a row failed",
//    so exactly one resume is bought before the second failure ends it.
{
  const host = makeHost({ maxConsecutiveFailures: 2, maxResumesPerWindow: 99 });
  const agent = host.addAgent('s5');
  for (let i = 0; i < 5; i++) {
    agent.status = 'running';
    host.emit('session/event', agent.session, turnEndError({ code: 'TRANSPORT', message: 'boom' }));
    agent.status = 'idle';
    agent.inbox.nextTurn.length = 0;
    await flush();
  }
  check('consecutive failure limit stops resuming', agent.followed.length, 1);
}

// 6. Assistant output alone is NOT progress: a long turn that emitted plenty of
//    content and then failed must still count toward the failure streak.
//    (Regression: the real outage on 2026-10-21 emitted 106 assistant messages
//    before the gateway dropped, which used to reset the counter every turn.)
{
  const host = makeHost({ maxConsecutiveFailures: 2, maxResumesPerWindow: 99 });
  const agent = host.addAgent('s6');
  for (let i = 0; i < 6; i++) {
    for (let n = 0; n < 50; n++) {
      host.emit('session/event', agent.session, { type: 'assistant/message', data: {} });
    }
    host.emit('session/event', agent.session, turnEndError({ code: 'SERVER', message: 'unavailable' }));
    agent.status = 'idle';
    agent.inbox.nextTurn.length = 0;
    await flush();
  }
  check('assistant output does not reset the failure streak', agent.followed.length, 1);
}

// 7. A turn that ends on its own terms DOES clear the streak.
{
  const host = makeHost({ maxConsecutiveFailures: 2, maxResumesPerWindow: 99 });
  const agent = host.addAgent('s7');
  for (let i = 0; i < 4; i++) {
    host.emit('session/event', agent.session, {
      type: 'turn/end',
      data: { turn: i, reason: { kind: 'completed' } },
    });
    host.emit('session/event', agent.session, turnEndError({ code: 'TRANSPORT', message: 'boom' }));
    agent.status = 'idle';
    agent.inbox.nextTurn.length = 0;
    await flush();
  }
  check('a completed turn resets the failure streak', agent.followed.length, 4);
}

// 8. A resume whose own turn fails again stands down quickly instead of
//    re-buying the same outage turn after turn.
{
  const host = makeHost({ maxConsecutiveFailures: 3, maxResumesPerWindow: 99 });
  const agent = host.addAgent('s8');
  for (let i = 0; i < 6; i++) {
    host.emit('session/event', agent.session, turnEndError({ code: 'SERVER', message: 'unavailable' }));
    agent.status = 'idle';
    // Simulate the resume being admitted (marks the turn as ours), then failing.
    const queued = agent.inbox.nextTurn[0];
    if (queued !== undefined) {
      host.emit('session/event', agent.session, { type: 'user/message', data: queued });
    }
    agent.inbox.nextTurn.length = 0;
    await flush();
  }
  // Storm merging also applies here: repeated SERVER failures are one storm, so
  // the consecutive-failure ceiling is exercised separately (test 5) and this
  // case only asserts the plugin does not keep buying turns forever.
  check('a failed resume does not keep buying turns', agent.followed.length, 1);
}

// 9. The rolling budget caps the number of resumes.
{
  const host = makeHost({ maxResumesPerWindow: 2, maxConsecutiveFailures: 99, maxResumesPerStorm: 99 });
  const agent = host.addAgent('s9');
  for (let i = 0; i < 6; i++) {
    host.emit('session/event', agent.session, {
      type: 'turn/end',
      data: { turn: i, reason: { kind: 'completed' } },
    });
    host.emit('session/event', agent.session, turnEndError({ code: 'TRANSPORT', message: 'boom' }));
    agent.status = 'idle';
    agent.inbox.nextTurn.length = 0;
    await flush();
  }
  check('rolling budget caps resumes', agent.followed.length, 2);
}

// 10. A storm — the same code failing repeatedly — buys only one resume.
//     This is the 2026-10-21 outage shape: every turn answered 503 SERVER.
{
  const host = makeHost({ maxConsecutiveFailures: 99, maxResumesPerWindow: 99, maxResumesPerStorm: 1 });
  const agent = host.addAgent('s10');
  for (let i = 0; i < 6; i++) {
    host.emit('session/event', agent.session, turnEndError({ code: 'SERVER', message: 'unavailable' }));
    agent.status = 'idle';
    agent.inbox.nextTurn.length = 0;
    await flush();
  }
  check('one storm buys only one resume', agent.followed.length, 1);
}

// 11. A different failure code opens a NEW storm, so it gets its own resume.
{
  const host = makeHost({ maxConsecutiveFailures: 99, maxResumesPerWindow: 99, maxResumesPerStorm: 1 });
  const agent = host.addAgent('s11');
  for (const code of ['SERVER', 'SERVER', 'STREAM_CLOSED', 'STREAM_CLOSED', 'TRANSPORT']) {
    host.emit('session/event', agent.session, turnEndError({ code, message: 'x' }));
    agent.status = 'idle';
    agent.inbox.nextTurn.length = 0;
    await flush();
  }
  check('each distinct storm gets one resume', agent.followed.length, 3);
}

// 12. The same code after a long gap is a new storm, not a continuation.
{
  const host = makeHost({
    maxConsecutiveFailures: 99,
    maxResumesPerWindow: 99,
    maxResumesPerStorm: 1,
    // The minimum the plugin accepts; the gap below exceeds it.
    stormWindowMs: 1000,
  });
  const agent = host.addAgent('s12');
  for (let i = 0; i < 3; i++) {
    host.emit('session/event', agent.session, turnEndError({ code: 'SERVER', message: 'x' }));
    agent.status = 'idle';
    agent.inbox.nextTurn.length = 0;
    await flush();
    // Longer than stormWindowMs, so the next failure starts a fresh storm.
    await new Promise((r) => setTimeout(r, 1100));
  }
  check('same code after the gap starts a new storm', agent.followed.length, 3);
}

// 8. Subagents are skipped when disabled.
{
  const host = makeHost({ includeSubagents: false });
  const agent = host.addAgent('s8', { origin: 'subagent' });
  host.emit('session/event', agent.session, turnEndError({ code: 'TRANSPORT', message: 'boom' }));
  agent.status = 'idle';
  await flush();
  check('subagent skipped when includeSubagents=false', agent.followed.length, 0);
}

// 9. An agent that is not idle never receives a resume.
{
  const host = makeHost({});
  const agent = host.addAgent('s9');
  host.emit('session/event', agent.session, turnEndError({ code: 'TRANSPORT', message: 'boom' }));
  await flush(); // still running
  check('busy agent is not resumed', agent.followed.length, 0);
}

// 10. Teardown cancels a deferred resume.
{
  const host = makeHost({});
  const agent = host.addAgent('s10');
  host.emit('session/event', agent.session, turnEndError({ code: 'TRANSPORT', message: 'boom' }));
  for (const dispose of host.ctx._disposers) dispose();
  agent.status = 'idle';
  await flush();
  check('disposed plugin does not resume', agent.followed.length, 0);
}

check('plugin name', name, 'auto-continue');
check('plugin injects agents+sessions', inject, ['agents', 'sessions']);

// --- Compatibility detection -------------------------------------------------
// A host missing a required interface must disable the plugin loudly instead of
// installing and silently doing nothing.

function makeBrokenHost(breakIt) {
  const logs = [];
  const listeners = new Map();
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    effect(factory) { factory(); },
    agents: {
      get: () => undefined,
      list: () => [],
    },
    get: () => undefined,
  };
  breakIt(ctx);
  apply(ctx, {});
  return { logs, listeners };
}

{
  const { logs, listeners } = makeBrokenHost((ctx) => { delete ctx.agents.get; });
  const errored = logs.filter(([level]) => level === 'error');
  check('missing agents.get disables the plugin', errored.length, 1);
  check('the warning names the requirement', errored[0]?.[1]?.includes('agents.get(id)'), true);
  check('no listeners registered when incompatible', listeners.size, 0);
}

{
  const { logs } = makeBrokenHost((ctx) => { ctx.on = undefined; });
  check('missing ctx.on disables the plugin',
    logs.filter(([level]) => level === 'error').length, 1);
}

{
  const { logs } = makeBrokenHost((ctx) => { delete ctx.agents.list; });
  check('missing agents.list disables the plugin',
    logs.filter(([level]) => level === 'error').length, 1);
}

// A live agent missing `followup` must also be caught.
{
  const logs = [];
  const listeners = new Map();
  const brokenAgent = {
    id: 'broken',
    status: 'idle',
    session: { id: 'broken', header: { id: 'broken' } },
    inbox: { nextTurn: [], nextStep: [], remove: () => false },
    // followup deliberately absent
  };
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => {};
    },
    effect(factory) { factory(); },
    agents: { get: () => undefined, list: () => [brokenAgent] },
    get: () => undefined,
  };
  apply(ctx, {});
  const errored = logs.filter(([level]) => level === 'error');
  check('an agent without followup disables the plugin', errored.length, 1);
  check('the warning names Agent.followup', errored[0]?.[1]?.includes('Agent.followup'), true);
}

// A compatible host must log the verification line and keep working.
{
  const host = makeHost({});
  check('a compatible host logs verification',
    host.logs.some(([level, m]) => level === 'info' && m.includes('host interfaces verified')), true);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
