// Mock runs for the Add-an-agent screens (SPEC-ADD-AGENT-1113 section 3.3). Each scenario is a list of frames the backend
// would send. `mockAddAgentApi(name)` replays them with ordinary timers (fake timers in tests). Nothing here talks to a program.
import { ERROR_COPY, type AddAgentApi, type AddAgentRun, type AddAgentStep, type AgentCaps, type Cap, type StepId, type StepState } from './addAgent';

export interface Frame {
  after_ms: number;
  run: AddAgentRun;
}
export interface Scenario {
  input: string;
  frames: Frame[];
}

const T0 = 1_763_000_000_000;
const AT = '2026-11-13T01:02:03Z';
const LIMITS: Record<StepId, number> = { find: 2000, version: 5000, chat_way: 10000, handshake: 8000, models: 0, save: 5000, install: 900000 };
const ORDER: StepId[] = ['find', 'version', 'chat_way', 'handshake', 'models', 'save', 'install'];

const none = (): Cap => ({ value: 'unknown', source: 'unknown', proof: '', at: null });
const cap = (value: 'yes' | 'no', source: Cap['source'], proof: string): Cap => ({ value, source, proof, at: AT });

/** A fresh capability record: everything unknown. */
export function emptyCaps(id: string, label: string): AgentCaps {
  return {
    schema: 1,
    agent_id: id,
    label,
    level: 'l5',
    level_proof: cap('yes', 'check', 'no chat way found'),
    program_version: null,
    chat: none(),
    resume: none(),
    shows_steps: none(),
    edits_files: none(),
    asks_before_edit: none(),
    asks_before_shell: none(),
    model_pick: none(),
    models: [],
    models_total: 0,
    stop: none(),
    images: none(),
    usage: none(),
    read_only: none(),
  };
}

export function chatCaps(id: string, label: string, over: Partial<AgentCaps> = {}): AgentCaps {
  return {
    ...emptyCaps(id, label),
    level: 'l0',
    level_proof: cap('yes', 'handshake', 'answered initialize, protocol 1'),
    program_version: '1.2.0',
    chat: cap('yes', 'handshake', 'answered initialize, protocol 1'),
    resume: cap('yes', 'handshake', 'load_session is on'),
    model_pick: cap('yes', 'handshake', 'session/new lists 2 models'),
    models: ['alpha-1', 'alpha-2'],
    models_total: 2,
    images: cap('no', 'handshake', 'image_prompts is off'),
    ...over,
  };
}

/** Terminal-only: chat is a No with a free-check proof. */
export function terminalCaps(id: string, label: string): AgentCaps {
  return { ...emptyCaps(id, label), program_version: '0.9.1', chat: cap('no', 'check', 'no chat way found') };
}

type Marks = Partial<Record<StepId, StepState>>;

function steps(marks: Marks, running?: StepId, elapsed = 0): AddAgentStep[] {
  return ORDER.map((id) => {
    const state: StepState = marks[id] ?? (id === running ? 'running' : 'pending');
    return {
      id,
      state,
      started_ms: state === 'pending' ? null : T0,
      elapsed_ms: state === 'running' ? elapsed : state === 'pending' ? null : 40,
      limit_ms: LIMITS[id],
      detail: id === 'version' && state === 'done' ? '1.2.0' : state === 'done' || state === 'failed' ? `internal note for ${id}` : null,
    };
  });
}

function run(id: string, input: string, label: string | null, patch: Partial<AddAgentRun>): AddAgentRun {
  return { run_id: `run_${id}`, input, agent_id: null, label, state: 'checking', started_ms: T0, steps: steps({}), install: null, result: null, error: null, ...patch };
}

function failed(code: keyof typeof ERROR_COPY, base: AddAgentRun, name: string, step: StepId | null): AddAgentRun {
  const row = ERROR_COPY[code];
  return { ...base, state: 'failed', error: { code, message: row.message.replace('{Name}', name), action: row.action, step } };
}

function done(id: string, input: string, label: string, marks: Marks, caps: AgentCaps, over: { mode?: 'chat' | 'terminal'; sign_in?: boolean } = {}): AddAgentRun {
  return run(id, input, label, {
    agent_id: input,
    state: 'done',
    steps: steps(marks),
    result: { agent_id: input, label, mode: over.mode ?? 'chat', caps, sign_in_needed: over.sign_in === true, already_added: false },
  });
}

const OK_ALL: Marks = { find: 'done', version: 'done', chat_way: 'done', handshake: 'done', models: 'done', save: 'done', install: 'skipped' };
const TERM_MARKS: Marks = { find: 'done', version: 'done', chat_way: 'skipped', handshake: 'skipped', models: 'skipped', save: 'done', install: 'skipped' };

function checkingFrames(id: string, input: string, label: string, handshakeMs: number): Frame[] {
  const r = (marks: Marks, running: StepId, elapsed = 0) => run(id, input, label, { steps: steps(marks, running, elapsed) });
  const out: Frame[] = [
    { after_ms: 0, run: run(id, input, null, { steps: steps({}, 'find') }) },
    { after_ms: 300, run: r({ find: 'done' }, 'version') },
    { after_ms: 800, run: r({ find: 'done', version: 'done' }, 'chat_way') },
    { after_ms: 1300, run: r({ find: 'done', version: 'done', chat_way: 'done' }, 'handshake') },
  ];
  // The running handshake is sent again every second so the timers on screen stay honest.
  for (let s = 1; s < Math.floor(handshakeMs / 1000); s++) out.push({ after_ms: 1300 + s * 1000, run: r({ find: 'done', version: 'done', chat_way: 'done' }, 'handshake', s * 1000) });
  return out;
}

function nativeOk(id: string, input: string, label: string, caps: AgentCaps, handshakeMs = 600, signIn = false): Frame[] {
  const base = checkingFrames(id, input, label, handshakeMs);
  const t = 1300 + handshakeMs;
  const marks1: Marks = { find: 'done', version: 'done', chat_way: 'done', handshake: 'done' };
  const tail: Frame[] = signIn
    ? [
        { after_ms: t, run: run(id, input, label, { steps: steps({ ...marks1, models: 'skipped' }, 'save') }) },
        { after_ms: t + 400, run: done(id, input, label, { ...OK_ALL, models: 'skipped' }, { ...caps, model_pick: none(), models: [], models_total: 0 }, { sign_in: true }) },
      ]
    : [
        { after_ms: t, run: run(id, input, label, { steps: steps({ ...marks1, models: 'done' }, 'save') }) },
        { after_ms: t + 400, run: done(id, input, label, OK_ALL, caps) },
      ];
  return [...base, ...tail];
}

const NAT = chatCaps('fakenat', 'Fakenat');
const failedAt = (id: string, input: string, label: string | null, code: keyof typeof ERROR_COPY, marks: Marks, running: StepId, step: StepId | null): AddAgentRun =>
  failed(code, run(id, input, label, { steps: steps({ ...marks, [running]: 'failed' }) }), label ?? input, step);

function registryAddon(): Frame[] {
  const id = 'registry_addon';
  const l = 'Fakereg';
  const needs = run(id, 'fakereg', l, {
    state: 'needs_install',
    steps: steps({ find: 'done', version: 'done', chat_way: 'done' }),
    install: { kind: 'chat_addon', label: l, what_will_run: ['npm install --prefix add-ons/fakereg fakereg-acp@1.4.0'], source_host: 'registry.npmjs.org', can_install: true },
  });
  const r = (marks: Marks, running: StepId) => run(id, 'fakereg', l, { steps: steps(marks, running) });
  const base: Marks = { find: 'done', version: 'done', chat_way: 'done' };
  const caps = chatCaps('fakereg', l);
  return [
    { after_ms: 0, run: run(id, 'fakereg', null, { steps: steps({}, 'find') }) },
    { after_ms: 300, run: r({ find: 'done' }, 'version') },
    { after_ms: 800, run: r({ find: 'done', version: 'done' }, 'chat_way') },
    { after_ms: 1200, run: needs },
    // after the person approves:
    { after_ms: 0, run: r(base, 'install') },
    { after_ms: 1500, run: r({ ...base, install: 'done' }, 'handshake') },
    { after_ms: 2200, run: r({ ...base, install: 'done', handshake: 'done' }, 'models') },
    { after_ms: 2600, run: r({ ...base, install: 'done', handshake: 'done', models: 'done' }, 'save') },
    { after_ms: 3000, run: done(id, 'fakereg', l, { ...OK_ALL, install: 'done' }, caps) },
  ];
}

export const SCENARIOS: Record<string, Scenario> = {
  native_ok: { input: 'fakenat', frames: nativeOk('native_ok', 'fakenat', 'Fakenat', NAT) },
  registry_addon: { input: 'fakereg', frames: registryAddon() },
  terminal_only: {
    input: 'faketerm',
    frames: [
      { after_ms: 0, run: run('terminal_only', 'faketerm', null, { steps: steps({}, 'find') }) },
      { after_ms: 300, run: run('terminal_only', 'faketerm', 'Faketerm', { steps: steps({ find: 'done' }, 'version') }) },
      { after_ms: 700, run: run('terminal_only', 'faketerm', 'Faketerm', { steps: steps({ find: 'done', version: 'done' }, 'chat_way') }) },
      { after_ms: 1100, run: run('terminal_only', 'faketerm', 'Faketerm', { steps: steps({ ...TERM_MARKS, save: undefined }, 'save') }) },
      { after_ms: 1500, run: done('terminal_only', 'faketerm', 'Faketerm', TERM_MARKS, terminalCaps('faketerm', 'Faketerm'), { mode: 'terminal' }) },
    ],
  },
  not_installed: {
    input: 'fakegone',
    frames: [
      { after_ms: 0, run: run('not_installed', 'fakegone', null, { steps: steps({}, 'find') }) },
      {
        after_ms: 500,
        run: run('not_installed', 'fakegone', 'Fakegone', {
          state: 'needs_install',
          steps: steps({ find: 'failed' }),
          install: { kind: 'program', label: 'Fakegone', what_will_run: ['npm install -g fakegone'], source_host: 'registry.npmjs.org', can_install: false },
        }),
      },
    ],
  },
  unknown_name: {
    input: 'zzzz',
    frames: [
      { after_ms: 0, run: run('unknown_name', 'zzzz', null, { steps: steps({}, 'find') }) },
      { after_ms: 400, run: failedAt('unknown_name', 'zzzz', null, 'ADD_UNKNOWN_NAME', {}, 'find', 'find') },
    ],
  },
  handshake_silent: {
    input: 'fakemute',
    frames: [
      ...checkingFrames('handshake_silent', 'fakemute', 'Fakemute', 8000),
      { after_ms: 9300, run: failedAt('handshake_silent', 'fakemute', 'Fakemute', 'ADD_HANDSHAKE_SILENT', { find: 'done', version: 'done', chat_way: 'done' }, 'handshake', 'handshake') },
    ],
  },
  handshake_bad: {
    input: 'fakeodd',
    frames: [
      ...checkingFrames('handshake_bad', 'fakeodd', 'Fakeodd', 1000).slice(0, 4),
      { after_ms: 1500, run: failedAt('handshake_bad', 'fakeodd', 'Fakeodd', 'ADD_HANDSHAKE_BAD', { find: 'done', version: 'done', chat_way: 'done' }, 'handshake', 'handshake') },
    ],
  },
  slow: { input: 'fakeslow', frames: nativeOk('slow', 'fakeslow', 'Fakeslow', chatCaps('fakeslow', 'Fakeslow'), 17000) },
  sign_in: { input: 'fakeauth', frames: nativeOk('sign_in', 'fakeauth', 'Fakeauth', chatCaps('fakeauth', 'Fakeauth'), 600, true) },
  already_added: {
    input: 'fakenat',
    frames: [
      { after_ms: 0, run: run('already_added', 'fakenat', null, { steps: steps({}, 'find') }) },
      { after_ms: 300, run: { ...failedAt('already_added', 'fakenat', 'Fakenat', 'ADD_ALREADY_ADDED', {}, 'find', 'find'), agent_id: 'fakenat' } },
    ],
  },
  install_failed: {
    input: 'fakereg',
    frames: [
      ...registryAddon().slice(0, 4),
      { after_ms: 0, run: run('install_failed', 'fakereg', 'Fakereg', { steps: steps({ find: 'done', version: 'done', chat_way: 'done' }, 'install') }) },
      { after_ms: 1500, run: failedAt('install_failed', 'fakereg', 'Fakereg', 'ADD_INSTALL_FAILED', { find: 'done', version: 'done', chat_way: 'done' }, 'install', 'install') },
    ],
  },
  chat_off: {
    input: 'fakenat',
    frames: [
      { after_ms: 0, run: run('chat_off', 'fakenat', null, { steps: steps({}, 'find') }) },
      { after_ms: 300, run: run('chat_off', 'fakenat', 'Fakenat', { steps: steps({ find: 'done' }, 'version') }) },
      { after_ms: 700, run: run('chat_off', 'fakenat', 'Fakenat', { steps: steps({ find: 'done', version: 'done' }, 'chat_way') }) },
      { after_ms: 1100, run: failedAt('chat_off', 'fakenat', 'Fakenat', 'ADD_CHAT_OFF', { find: 'done', version: 'done' }, 'chat_way', 'chat_way') },
    ],
  },
  cancelled: { input: 'fakeslow', frames: nativeOk('cancelled', 'fakeslow', 'Fakeslow', chatCaps('fakeslow', 'Fakeslow'), 17000) },
};

/** A scenario's run under the typed name (a terminal-only restart reuses the frames of another agent). */
function asTyped(r: AddAgentRun, input: string, runId: string): AddAgentRun {
  const label = input.charAt(0).toUpperCase() + input.slice(1);
  return {
    ...r,
    run_id: runId,
    input,
    label: r.label ? label : null,
    agent_id: r.agent_id ? input : null,
    result: r.result ? { ...r.result, agent_id: input, label, caps: { ...r.result.caps, agent_id: input, label } } : null,
  };
}

/**
 * An api that replays one scenario. `start` returns the first frame at once and sends the rest on timers; a frame that needs
 * an install pauses the replay until `approveInstall`. `status` returns the latest frame. `cancel` stops the replay.
 * A terminal-only start plays the `terminal_only` frames under the typed name.
 */
export function mockAddAgentApi(name: string): AddAgentApi & { starts: Array<{ input: string; terminalOnly: boolean }> } {
  let listeners: Array<(r: AddAgentRun) => void> = [];
  let timers: ReturnType<typeof setTimeout>[] = [];
  let latest: AddAgentRun | null = null;
  let queue: Frame[] = [];
  const starts: Array<{ input: string; terminalOnly: boolean }> = [];

  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const emit = (r: AddAgentRun) => {
    latest = r;
    listeners.forEach((cb) => cb(r));
  };
  /** Sends the frames after the first one on timers; stops after a frame that waits for the person. */
  const play = (frames: Frame[]) => {
    const base = frames[0].after_ms;
    for (let i = 1; i < frames.length; i++) {
      const f = frames[i];
      timers.push(setTimeout(() => emit(f.run), f.after_ms - base));
      if (f.run.state === 'needs_install') {
        queue = frames.slice(i + 1);
        return;
      }
    }
    queue = [];
  };

  return {
    starts,
    async start(input, terminalOnly = false) {
      clear();
      starts.push({ input, terminalOnly });
      const key = terminalOnly ? 'terminal_only' : name;
      const scenario = SCENARIOS[key] ?? SCENARIOS.native_ok;
      const frames = terminalOnly ? scenario.frames.map((f) => ({ ...f, run: asTyped(f.run, input, `run_${key}_${starts.length}`) })) : scenario.frames;
      latest = frames[0].run;
      play(frames);
      return frames[0].run;
    },
    async status(runId) {
      if (!latest || latest.run_id !== runId) throw new Error('ADD_RUN_NOT_FOUND: That check is gone. Start again.');
      return latest;
    },
    async cancel(runId) {
      clear();
      if (!latest || latest.run_id !== runId) throw new Error('ADD_RUN_NOT_FOUND: That check is gone. Start again.');
      latest = { ...latest, state: 'cancelled' };
      return latest;
    },
    async approveInstall(runId) {
      if (!latest || latest.run_id !== runId) throw new Error('ADD_RUN_NOT_FOUND: That check is gone. Start again.');
      const rest = queue;
      queue = [];
      if (rest.length === 0) return latest;
      emit(rest[0].run);
      play(rest);
      return rest[0].run;
    },
    async onProgress(cb) {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
  };
}
