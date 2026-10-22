/**
 * Host half of `@local/dsh-auto-continue`.
 *
 * Why this exists: the agent loop treats one failed model request as the end of
 * the turn (`turn/end { kind: 'error' }`). `@deepseek-ai/dsh-llm-retry` only
 * re-runs a failed *step* inside that turn, and only for the failure codes its
 * provider policy lists. When the gateway cuts a long SSE stream — or a policy
 * budget runs out — the turn dies and the session sits idle until a human types
 * something. This plugin closes that gap at the turn boundary.
 *
 * Invariants it keeps:
 *  - The session log stays the only source of truth: the resume prompt is an
 *    ordinary identified user message handed to `Agent.followup()`.
 *  - A manual stop always wins. The resume is queued immediately (never behind
 *    an invisible timer), so `cancel()` finds a real pending message and clears
 *    it; this plugin observes that removal and stands down.
 *  - Permanent failures are never retried, and every session has a bounded
 *    budget, so a broken route cannot burn the account in a loop.
 *  - This module imports nothing but Node builtins: a linked bundle resolves
 *    bare specifiers from its real path, outside the profile, so it must be
 *    self-contained to work wherever it is installed from.
 *
 * @module @local/dsh-auto-continue
 */
import { randomUUID } from 'node:crypto';

export const name = 'auto-continue';

/** The agent registry and its session log are the only required services. */
export const inject = ['agents', 'sessions'];

/** Message-source tag that marks this plugin's own resume prompts. */
const SOURCE_KIND = 'auto-continue';

/**
 * Failure codes that can never succeed on a later attempt. Anything else counts
 * as transient: an unlisted code is far more likely to be a new gateway hiccup
 * than a permanent rejection, and the budget bounds the cost of being wrong.
 */
const PERMANENT_CODES = new Set([
  'ABORTED',
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'INVALID_REQUEST',
  'INVALID_CONFIG',
  'UNKNOWN_MODEL',
  'NO_ADAPTER',
  'DUPLICATE_ADAPTER',
  'INVALID_ADAPTER',
  'CONTEXT_WINDOW_EXCEEDED',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'IMAGE_OFFLOAD_REQUIRED',
]);

/** Conservative defaults; every value can be overridden in `cordis.patch.yml`. */
const DEFAULTS = Object.freeze({
  enabled: true,
  maxResumesPerWindow: 5,
  windowMs: 3_600_000,
  maxConsecutiveFailures: 3,
  includeSubagents: true,
  /**
   * Failures of the same code within this window are one storm, not several
   * independent incidents. A provider outage returns the same 503 for minutes
   * at a time; without merging, each failed turn looks like a fresh event.
   */
  stormWindowMs: 120_000,
  /** How many resumes one storm is allowed to buy. */
  maxResumesPerStorm: 1,
});

/** Coerce one numeric config field, falling back to its default. */
function numberField(config, key, fallback, minimum) {
  const value = config?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) return fallback;
  return value;
}

/**
 * Read the row's config without a schema dependency.
 * @param config - the raw config object from the patch entry.
 * @returns resolved values plus any unknown keys worth warning about.
 */
function resolveConfig(config) {
  const known = new Set(Object.keys(DEFAULTS));
  const unknown = Object.keys(config ?? {}).filter((key) => !known.has(key));
  return {
    enabled: typeof config?.enabled === 'boolean' ? config.enabled : DEFAULTS.enabled,
    maxResumesPerWindow: Math.floor(
      numberField(config, 'maxResumesPerWindow', DEFAULTS.maxResumesPerWindow, 0),
    ),
    windowMs: numberField(config, 'windowMs', DEFAULTS.windowMs, 1000),
    maxConsecutiveFailures: Math.max(
      1,
      Math.floor(numberField(config, 'maxConsecutiveFailures', DEFAULTS.maxConsecutiveFailures, 1)),
    ),
    includeSubagents: typeof config?.includeSubagents === 'boolean'
      ? config.includeSubagents
      : DEFAULTS.includeSubagents,
    stormWindowMs: numberField(config, 'stormWindowMs', DEFAULTS.stormWindowMs, 1000),
    maxResumesPerStorm: Math.floor(
      numberField(config, 'maxResumesPerStorm', DEFAULTS.maxResumesPerStorm, 0),
    ),
    unknown,
  };
}

/** Resume prompt handed to the model after a transient failure. */
function resumeText(failure, attempt) {
  const code = typeof failure?.code === 'string' ? failure.code : 'UNKNOWN';
  const message = typeof failure?.message === 'string' ? failure.message : String(failure);
  return [
    '<auto_continue>',
    `The previous turn ended because a model request failed: ${code}: ${message}`,
    `This is automatic resume attempt ${attempt}. The session state above is authoritative.`,
    'Re-check the current workspace and tool results instead of assuming earlier narration is still current, then continue the task from where it stopped.',
    'Do not repeat tool calls whose results are already in the transcript.',
    '</auto_continue>',
  ].join('\n');
}

/**
 * Build the resume message locally instead of importing `createUserMessage`,
 * keeping this module free of package specifiers.
 * @param failure - the failure record that ended the turn.
 * @param attempt - 1-based attempt number inside the current budget window.
 * @returns a frozen user message the loop can admit.
 */
function resumeMessage(failure, attempt) {
  const content = Object.freeze([Object.freeze({ type: 'text', text: resumeText(failure, attempt) })]);
  const source = Object.freeze({ kind: SOURCE_KIND, attempt });
  return Object.freeze({ id: randomUUID(), role: 'user', content, source });
}

/** Render a failure for a log line without trusting its shape. */
function describeFailure(value) {
  if (value === null || typeof value !== 'object') return String(value);
  const code = typeof value.code === 'string' ? value.code : undefined;
  const message = typeof value.message === 'string' ? value.message : String(value);
  return code === undefined ? message : `${code}: ${message}`;
}

/**
 * Probe the host for every interface this plugin drives, so an incompatible
 * Harness fails loudly at activation instead of silently doing nothing.
 *
 * The checks are structural, not version-string based: the plugin reads these
 * shapes, so their presence is what matters. Each entry names the requirement
 * and the reason, so the warning says what to upgrade rather than just "broken".
 *
 * @param ctx - the plugin context.
 * @returns the list of unmet requirements; empty means compatible.
 */
function findIncompatibilities(ctx) {
  const missing = [];
  const need = (condition, requirement, reason) => {
    if (!condition) missing.push({ requirement, reason });
  };

  // Services this plugin declares in `inject`; a missing one means the profile
  // never mounts it, and Cordis would not call apply() at all.
  need(typeof ctx.agents?.get === 'function', 'agents.get(id)', 'look up the live Agent for a session');
  need(typeof ctx.on === 'function', 'ctx.on()', 'observe session and agent events');
  need(typeof ctx.effect === 'function', 'ctx.effect()', 'own the listener lifetime');

  // Agent surface: status, inbox and followup are the whole resume mechanism.
  // Probed on a real live agent when one exists, since these are instance
  // members rather than service methods.
  const sample = typeof ctx.agents?.list === 'function' ? ctx.agents.list()[0] : undefined;
  if (sample !== undefined) {
    need(typeof sample.followup === 'function', 'Agent.followup(message)', 'queue the resume prompt');
    need(sample.inbox !== undefined && Array.isArray(sample.inbox.nextTurn),
      'Agent.inbox.nextTurn', 'detect queued input before resuming');
    need(sample.inbox !== undefined && Array.isArray(sample.inbox.nextStep),
      'Agent.inbox.nextStep', 'detect queued steering before resuming');
    need(typeof sample.inbox?.remove === 'function', 'Agent.inbox.remove(id)',
      'retract a resume when a human takes over');
    need(typeof sample.status === 'string', 'Agent.status', 'avoid resuming a busy agent');
    need(sample.session !== undefined && typeof sample.session === 'object',
      'Agent.session', 'match session events to their agent');
  } else {
    // No agent is live yet at activation. The listener still needs the registry
    // shape, and the per-agent members are re-checked on first use.
    need(typeof ctx.agents?.list === 'function', 'agents.list()',
      'inspect live agents at activation (none were live yet)');
  }

  return missing;
}

/**
 * Install automatic resume at the turn boundary.
 * @param ctx - the plugin context.
 * @param config - the row's raw config object.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  for (const key of resolved.unknown) {
    ctx.logger.warn(`auto-continue: ignoring unknown config key "${key}"`);
  }
  if (!resolved.enabled) {
    ctx.logger.info('auto-continue: disabled by config');
    return;
  }

  // Fail loudly on an incompatible Harness: a plugin that cannot observe
  // `session/event` or cannot call `followup()` would otherwise look installed
  // and silently never resume anything.
  const incompatible = findIncompatibilities(ctx);
  if (incompatible.length > 0) {
    const detail = incompatible.map((item) => `  - ${item.requirement}: needed to ${item.reason}`).join('\n');
    ctx.logger.error(
      `auto-continue: disabling itself — this DeepSeek Harness does not expose ${incompatible.length} required interface(s):\n${detail}\n` +
      'Upgrade Harness, or remove the auto-continue bundle from the profile. Nothing will be resumed while disabled.',
    );
    return;
  }
  ctx.logger.info('auto-continue: host interfaces verified, resuming enabled');

  const {
    maxResumesPerWindow,
    windowMs,
    maxConsecutiveFailures,
    includeSubagents,
    stormWindowMs,
    maxResumesPerStorm,
  } = resolved;

  /** Per-agent bookkeeping, keyed by the live Agent object. */
  const states = new Map();
  /** Deferred dispatches owned by this plugin, so teardown can cancel them. */
  const pending = new Set();
  const lifetime = new AbortController();

  /** State for one live agent, created on first sight. */
  function stateFor(agent) {
    const existing = states.get(agent);
    if (existing !== undefined) return existing;
    const state = {
      /** Timestamps of automatic resumes inside the rolling window. */
      stamps: [],
      /** Consecutive failed turns since the last turn that ended on its own terms. */
      consecutive: 0,
      /** Id of the resume message this plugin queued and has not yet consumed. */
      pendingMessageId: undefined,
      /** Whether the turn now ending was started by this plugin's resume prompt. */
      resumeInFlight: false,
      /**
       * The storm currently absorbing failures: one failure code plus the time
       * of its most recent member. Failures of the same code inside
       * `stormWindowMs` extend it instead of opening a new one.
       */
      storm: undefined,
      /** How many resumes this storm has already bought. */
      stormResumes: 0,
    };
    states.set(agent, state);
    return state;
  }

  /** Whether the rolling budget still allows one more resume. */
  function budgetLeft(state, now) {
    state.stamps = state.stamps.filter((time) => now - time < windowMs);
    return state.stamps.length < maxResumesPerWindow;
  }

  /**
   * Fold one failure into the agent's storm state.
   *
   * A storm is "the same failure code, still occurring". A provider outage
   * answers every request with the same 503 for minutes, so consecutive
   * failures of one code inside `stormWindowMs` are one incident; a different
   * code, or the same code after a long gap, starts a new one.
   *
   * @param state - the agent's bookkeeping.
   * @param code - the failure code, or undefined when the failure carries none.
   * @param now - current epoch milliseconds.
   * @returns whether this failure extends an existing storm.
   */
  function foldStorm(state, code, now) {
    const current = state.storm;
    const continues = current !== undefined
      && current.code === code
      && now - current.lastAt < stormWindowMs;
    if (continues) {
      current.lastAt = now;
      return true;
    }
    state.storm = { code, lastAt: now };
    state.stormResumes = 0;
    return false;
  }

  /** Run one dispatch after the current synchronous append boundary closes. */
  function defer(operation) {
    if (lifetime.signal.aborted) return;
    const handle = setImmediate(() => {
      pending.delete(handle);
      if (lifetime.signal.aborted) return;
      try {
        operation();
      } catch (error) {
        ctx.logger.warn(`auto-continue: deferred dispatch failed: ${String(error)}`);
      }
    });
    pending.add(handle);
  }

  /** Drop this plugin's claim on one agent's queued resume. */
  function forget(state) {
    state.pendingMessageId = undefined;
  }

  /** Whether this agent is a delegated child session. */
  function isSubagent(agent) {
    return agent.session?.header?.origin === 'subagent';
  }

  /** Whether an armed goal already owns continuation for this agent. */
  function goalDrives(agent) {
    const goals = ctx.get('goals');
    if (goals === undefined) return false;
    try {
      const goal = goals.get(agent);
      return goal !== undefined && goal.phase === 'active' && goal.activation === 'armed';
    } catch {
      return false;
    }
  }

  /** Queue one resume prompt for a live, idle agent. */
  function queueResume(agent, failure) {
    if (lifetime.signal.aborted) return;
    if (ctx.agents.get(agent.id) !== agent) return;
    if (agent.status !== 'idle') return;
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) return;
    if (!includeSubagents && isSubagent(agent)) return;
    if (goalDrives(agent)) return;

    const state = stateFor(agent);
    // `consecutive` already counts the failure that just ended this turn, so
    // `>=` enforces exactly `maxConsecutiveFailures` failed turns before the
    // plugin stands down. (Using `>` would silently allow one extra.)
    if (state.consecutive >= maxConsecutiveFailures) {
      ctx.logger.warn(
        `auto-continue: agent "${agent.id}" stopped after ${state.consecutive} consecutive failed turns (last: ${describeFailure(failure)})`,
      );
      return;
    }
    const now = Date.now();
    if (!budgetLeft(state, now)) {
      ctx.logger.warn(
        `auto-continue: agent "${agent.id}" spent its ${maxResumesPerWindow}-resume budget within ${Math.round(windowMs / 60000)}min; not resuming (last: ${describeFailure(failure)})`,
      );
      return;
    }
    // One outage, one resume. A provider that keeps answering with the same
    // code is not several incidents, so the storm itself gets a small budget
    // instead of one resume per failed turn.
    const code = typeof failure?.code === 'string' ? failure.code : undefined;
    if (state.storm !== undefined && state.stormResumes >= maxResumesPerStorm) {
      ctx.logger.warn(
        `auto-continue: agent "${agent.id}" is inside a ${code ?? 'UNKNOWN'} storm that already spent ${state.stormResumes}/${maxResumesPerStorm} resume(s); waiting it out (last: ${describeFailure(failure)})`,
      );
      return;
    }

    const attempt = state.stamps.length + 1;
    const message = resumeMessage(failure, attempt);
    state.pendingMessageId = message.id;
    // A resume only spends budget when it is actually queued. The budget is
    // recorded here, not on failure, so a turn that fails with no resume
    // available never burns the window.
    state.stamps.push(now);
    state.stormResumes += 1;
    ctx.logger.info(
      `auto-continue: agent "${agent.id}" resuming (attempt ${attempt}) after ${describeFailure(failure)}`,
    );
    agent.followup(message);
  }

  /** Observe one committed session event belonging to one live agent. */
  function observe(agent, event) {
    const state = stateFor(agent);
    switch (event.type) {
      case 'turn/end': {
        const reason = event.data.reason;
        if (reason.kind === 'aborted') {
          // A human stop, a parent stop, or teardown. Stand down completely.
          forget(state);
          state.consecutive = 0;
          state.resumeInFlight = false;
          state.storm = undefined;
          state.stormResumes = 0;
          return;
        }
        if (reason.kind !== 'error') {
          // A turn that ended on its own terms — completed, blocked, max-tokens,
          // interrupted, forked — is the only evidence that the work advanced.
          // This is what clears the failure streak and closes the storm.
          forget(state);
          state.consecutive = 0;
          state.resumeInFlight = false;
          state.storm = undefined;
          state.stormResumes = 0;
          return;
        }
        const failure = reason.error;
        const code = typeof failure?.code === 'string' ? failure.code : undefined;
        if (code !== undefined && PERMANENT_CODES.has(code)) {
          forget(state);
          state.consecutive = 0;
          state.resumeInFlight = false;
          state.storm = undefined;
          state.stormResumes = 0;
          return;
        }
        state.consecutive += 1;
        // A failed turn that the plugin itself started is direct evidence the
        // provider is still down: resuming again immediately would just burn
        // another turn's tokens on the same outage.
        const ownResumeFailed = state.resumeInFlight;
        forget(state);
        state.resumeInFlight = false;
        const continuing = foldStorm(state, code, Date.now());
        if (ownResumeFailed) {
          ctx.logger.warn(
            `auto-continue: agent "${agent.id}" resume attempt failed (streak ${state.consecutive}, ${continuing ? 'storm continues' : 'new storm'}); backing off instead of resuming again (last: ${describeFailure(failure)})`,
          );
        }
        defer(() => queueResume(agent, failure));
        return;
      }
      case 'assistant/message':
        // Deliberately NOT treated as progress. A long turn emits plenty of
        // assistant output before the provider drops the connection, so
        // "something was produced" says nothing about whether the work advanced.
        // Only a turn that ends on its own terms clears the failure streak —
        // see the `turn/end` branch below.
        return;
      case 'user/message': {
        const source = event.data.source;
        if (source?.kind !== SOURCE_KIND) {
          // A human took over: retract a resume still waiting in the inbox and
          // close any storm, because the human's turn may well succeed.
          const queued = state.pendingMessageId;
          forget(state);
          state.consecutive = 0;
          state.storm = undefined;
          state.stormResumes = 0;
          if (queued !== undefined) {
            defer(() => {
              if (ctx.agents.get(agent.id) === agent) agent.inbox.remove(queued);
            });
          }
          return;
        }
        // This plugin's own prompt entered a turn; the claim is consumed and the
        // turn it opens is marked as ours, so a failure inside it counts as a
        // failed resume rather than a fresh independent outage.
        forget(state);
        state.resumeInFlight = true;
        return;
      }
      case 'agent/inbox/spliced': {
        const queued = state.pendingMessageId;
        if (queued === undefined) return;
        // The loop cancels pending input by splicing it out — a manual stop and
        // an explicit removal both land here. Trust the live inbox, not the
        // splice arithmetic, because `next-step` splices share this event type.
        if (!agent.inbox.nextTurn.some((message) => message.id === queued)) forget(state);
        return;
      }
      default:
        return;
    }
  }

  ctx.effect(() => {
    const disposers = [];

    // A disposed agent must not keep bookkeeping alive.
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      states.delete(agent);
    }));

    // Every committed event of every live agent's session reaches this
    // listener; sessions without a live agent are ignored.
    disposers.push(ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id);
      if (agent === undefined || agent.session !== session) return;
      try {
        observe(agent, event);
      } catch (error) {
        ctx.logger.warn(`auto-continue: observation failed for agent "${agent.id}": ${String(error)}`);
      }
    }));

    return () => {
      lifetime.abort(new Error('auto-continue disposed'));
      for (const disposer of disposers) {
        try {
          disposer();
        } catch {
          // A failed unregister must not block the rest of teardown.
        }
      }
      for (const handle of pending) clearImmediate(handle);
      pending.clear();
      states.clear();
    };
  }, 'auto-continue lifecycle');
}
