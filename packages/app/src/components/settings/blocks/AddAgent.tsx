// "Add an agent": one box. Type a name (or paste an install command) and Potato does the rest with free checks only.
// The screens: idle, checking, needs install (asks once), done (chat or terminal) and failed (one message, one button).
// The run lives in the app; this component only draws the latest copy it was sent. Tests and mocks inject `api`.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentLogo } from '../../common/AgentLogo';
import {
  actionButton,
  addAgentApi,
  ERROR_COPY,
  FALLBACK_ERROR,
  nameOf,
  SLOW_AFTER_MS,
  SLOW_NOTE,
  type AddAgentApi,
  type AddAgentRun,
} from '../../../lib/addAgent';
import type { WizardApi } from '../../../lib/agentWizard';
import { errorCode, errorSentence } from '../../../lib/sayError';
import { takeAddAgentPrefill } from '../agents/agentTarget';
import { Btn } from '../settings-ui';
import { AddAgentAdvanced } from './AddAgentAdvanced';
import { AddAgentFound } from './AddAgentFound';
import { Chips, InstallScreen, StepList } from './AddAgentParts';
import '../../../styles/addAgent.css';

const STORE_KEY = 'pm.addAgent.runId';

function remember(id: string | null) {
  try {
    if (id) globalThis.sessionStorage?.setItem(STORE_KEY, id);
    else globalThis.sessionStorage?.removeItem(STORE_KEY);
  } catch {
    // no storage: the run is just not restored after a remount
  }
}

function remembered(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(STORE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** A failed call as a run the Failed screen can draw: the table's words for a known code, else one plain sentence. */
function failedRun(e: unknown, input: string): AddAgentRun {
  const code = errorCode(e) ?? 'ADD_SAVE_FAILED';
  const row = ERROR_COPY[code];
  const message = row ? row.message.replace('{Name}', input.trim() || 'it') : errorSentence(e) || FALLBACK_ERROR;
  return {
    run_id: '',
    input,
    agent_id: null,
    label: null,
    state: 'failed',
    started_ms: Date.now(),
    steps: [],
    install: null,
    result: null,
    error: { code, message, action: row?.action ?? 'retry', step: null },
  };
}

/** The failed screen's title. A known code uses the table's words, so the agent's name stays in the line. */
function failedTitle(run: AddAgentRun): string {
  const code = run.error?.code;
  const row = code === 'ADD_INSTALL_FAILED' ? ERROR_COPY[code] : undefined;
  if (row) return row.message.replace('{Name}', nameOf(run) || 'It');
  return run.error?.message || FALLBACK_ERROR;
}

/** Why an install failed, in one line: the last line the installer wrote. Empty when it wrote none. */
function failedReason(run: AddAgentRun): string {
  // Only the install step: its output is the installer's own words. Other steps' notes are internal.
  for (const step of [...run.steps].reverse().filter((x) => x.id === 'install')) {
    const lines = (step.detail ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1].slice(0, 200);
  }
  return '';
}

export interface AddAgentProps {
  api?: AddAgentApi;
  wizardApi?: WizardApi;
  /** "Start a chat" on the result. */
  onStartChat?: (agentId: string) => void;
  /** "Open in a terminal" and "Open {Name}" on a terminal-only result. */
  onOpenTerminal?: (agentId: string) => void;
  /** "Open {Name}" after "already added". */
  onOpenAgent?: (agentId: string) => void;
  onShowInstall?: () => void;
  onRestartApp?: () => void;
  onOpenLabs?: () => void;
  /** The project folder, for "Found on this computer". */
  projectDir?: string | null;
}

export function AddAgent({ api = addAgentApi, wizardApi, onStartChat, onOpenTerminal, onOpenAgent, onShowInstall, onRestartApp, onOpenLabs, projectDir }: AddAgentProps) {
  // "Install" on an agent's page brings the name here, typed in.
  const [text, setText] = useState(() => takeAddAgentPrefill() ?? '');
  const [run, setRun] = useState<AddAgentRun | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [lastRun, setLastRun] = useState<AddAgentRun | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const runRef = useRef<AddAgentRun | null>(null);
  const waitingRef = useRef(false);
  const receivedRef = useRef(Date.now());
  const seenRef = useRef<{ id: string; at: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // "Add all": the ids still waiting. A run that does not finish clears it.
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState(0);

  const adopt = useCallback((next: AddAgentRun) => {
    const t = Date.now();
    receivedRef.current = t;
    if (!seenRef.current || seenRef.current.id !== next.run_id) {
      // The first time this run is seen: count from now, less what the steps already took (a run restored after a remount).
      const spent = next.steps.reduce((sum, s) => sum + (s.state === 'running' || s.state === 'done' ? (s.elapsed_ms ?? 0) : 0), 0);
      seenRef.current = { id: next.run_id, at: t - spent };
    }
    runRef.current = next;
    setRun(next);
    setLastRun(next);
    setNow(t);
    remember(next.state === 'failed' || next.state === 'cancelled' ? null : next.run_id);
  }, []);

  const toIdle = useCallback((message: string | null) => {
    queueRef.current = [];
    setQueued(0);
    runRef.current = null;
    seenRef.current = null;
    setRun(null);
    setNote(message);
    remember(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // Progress arrives as the whole run. Only the run on screen (or the one being started) is drawn.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let gone = false;
    void api
      .onProgress((next) => {
        if (waitingRef.current || next.run_id === runRef.current?.run_id) adopt(next);
      })
      .then((fn) => {
        if (gone) fn();
        else stop = fn;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      stop?.();
    };
  }, [api, adopt]);

  // A run that was going when this screen was left comes back.
  useEffect(() => {
    const id = remembered();
    if (!id) return undefined;
    let alive = true;
    api
      .status(id)
      .then((r) => alive && !runRef.current && adopt(r))
      .catch(() => remember(null));
    return () => {
      alive = false;
    };
  }, [api, adopt]);

  const checking = run?.state === 'checking';
  useEffect(() => {
    if (!checking) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [checking]);

  const begin = useCallback(
    async (input: string, terminalOnly = false) => {
      const typed = input.trim();
      if (!typed) return;
      setBusy(true);
      setNote(null);
      waitingRef.current = true;
      try {
        adopt(await api.start(typed, terminalOnly || undefined));
      } catch (e) {
        adopt(failedRun(e, typed));
      } finally {
        waitingRef.current = false;
        setBusy(false);
      }
    },
    [api, adopt],
  );

  // The next agent of "Add all" starts a moment after the last one finished. Anything else stops the line.
  const state = run?.state;
  useEffect(() => {
    if (state === 'done' && queueRef.current.length > 0) {
      const t = setTimeout(() => {
        const next = queueRef.current.shift();
        setQueued(queueRef.current.length);
        if (next) void begin(next);
      }, 900);
      return () => clearTimeout(t);
    }
    if ((state === 'failed' || state === 'cancelled' || state === 'needs_install') && queueRef.current.length > 0) {
      queueRef.current = [];
      setQueued(0);
    }
    return undefined;
  }, [state, run?.run_id, begin]);

  const addAll = (ids: string[]) => {
    const [first, ...rest] = ids;
    if (!first) return;
    queueRef.current = rest;
    setQueued(rest.length);
    void begin(first);
  };

  const cancel = () => {
    const id = run?.run_id;
    toIdle('Stopped. Nothing was added.');
    if (id) void api.cancel(id).catch(() => undefined);
  };

  const notNow = () => {
    const id = run?.run_id;
    toIdle(null);
    if (id) void api.cancel(id).catch(() => undefined);
  };

  const install = async () => {
    if (!run) return;
    setBusy(true);
    try {
      adopt(await api.approveInstall(run.run_id));
    } catch (e) {
      adopt(failedRun(e, run.input));
    } finally {
      setBusy(false);
    }
  };

  const doAction = (r: AddAgentRun) => {
    const err = r.error;
    if (!err) return;
    const id = r.result?.agent_id ?? r.agent_id ?? r.input.trim();
    switch (err.action) {
      case 'retry':
        toIdle(null);
        break;
      case 'use_terminal':
        void begin(r.input, true);
        break;
      case 'open_agent':
        onOpenAgent?.(id);
        break;
      case 'show_install':
        onShowInstall?.();
        break;
      case 'restart_app':
        onRestartApp?.();
        break;
      case 'open_labs':
        onOpenLabs?.();
        break;
      default:
        break;
    }
  };

  const slow = checking && run && now - (seenRef.current?.at ?? now) >= SLOW_AFTER_MS;

  return (
    <section className="aa" aria-label="Add an agent" data-state={run?.state ?? 'idle'}>
      {!run && (
        <div className="aa-body">
          {/* The agents already on this computer come first: one click each. Typing a name is the second way. */}
          <AddAgentFound api={api} projectDir={projectDir} disabled={busy} onAdd={(id) => void begin(id)} onAddAll={addAll} />
          <div className="aa-head">
            <p className="aa-sub aa-or">Or type a name, or paste its install command.</p>
            <button type="button" className="aa-link" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
              {advanced ? 'Hide advanced' : 'Advanced'}
            </button>
          </div>
          <form
            className="aa-form"
            onSubmit={(e) => {
              e.preventDefault();
              void begin(text);
            }}
          >
            <input
              ref={inputRef}
              className="st-field aa-input"
              aria-label="Agent name"
              placeholder="kimi"
              value={text}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
            />
            {/* Quiet while the box is empty; the dark button once there is something to add. */}
            <Btn primary={text.trim() !== ''} type="submit" disabled={busy || text.trim() === ''}>
              Add
            </Btn>
          </form>
          {note && (
            <p className="aa-note" role="status">
              {note}
            </p>
          )}
        </div>
      )}

      {run?.state === 'checking' && (
        <div className="aa-body">
          <h3 className="aa-title">Adding {nameOf(run)}</h3>
          <StepList run={run} receivedAt={receivedRef.current} now={now} />
          {slow && (
            <p className="aa-quiet" role="status">
              {SLOW_NOTE}
            </p>
          )}
          {queued > 0 && <p className="aa-quiet">{queued} more to add after this.</p>}
          <div className="aa-actions">
            <Btn onClick={cancel}>Cancel</Btn>
          </div>
        </div>
      )}

      {run?.state === 'needs_install' && (
        <InstallScreen
          run={run}
          busy={busy}
          onInstall={() => void install()}
          onNotNow={notNow}
          onCheckAgain={() => void begin(run.input)}
          onTerminal={() => void begin(run.input, true)}
        />
      )}

      {run?.state === 'done' && run.result && (
        <div className="aa-body">
          {run.result.mode === 'terminal' ? (
            <>
              <h3 className="aa-title"><AgentLogo id={run.result.agent_id} name={run.result.label} size={16} decorative className="aa-logo" /> {run.result.label} works in a terminal window.</h3>
              <p className="aa-sub">It cannot chat here.</p>
              <div className="aa-actions">
                <Btn primary onClick={() => onOpenTerminal?.(run.result!.agent_id)}>
                  Open {run.result.label}
                </Btn>
                <button type="button" className="aa-link" onClick={() => { setText(''); toIdle(null); }}>
                  Add another
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="aa-title"><AgentLogo id={run.result.agent_id} name={run.result.label} size={16} decorative className="aa-logo" /> {run.result.label} is {run.result.sign_in_needed ? 'added' : 'ready'}.</h3>
              {run.result.sign_in_needed && <p className="aa-signin">Sign in first, then start a chat.</p>}
              <Chips caps={run.result.caps} name={run.result.label} />
              <div className="aa-actions">
                <Btn primary onClick={() => onStartChat?.(run.result!.agent_id)}>
                  Start a chat
                </Btn>
                <Btn onClick={() => onOpenTerminal?.(run.result!.agent_id)}>Open in a terminal</Btn>
                <button type="button" className="aa-link" onClick={() => { setText(''); toIdle(null); }}>
                  Add another
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {run?.state === 'failed' && run.error && (
        <div className="aa-body">
          <h3 className="aa-title">{failedTitle(run)}</h3>
          {failedReason(run) && (
            <p className="aa-reason" data-testid="aa-reason">
              {failedReason(run)}
            </p>
          )}
          <div className="aa-actions">
            {actionButton(run.error.action, nameOf(run)) && !(run.error.action === 'restart_app' && !onRestartApp) && (
              <Btn primary disabled={busy} onClick={() => doAction(run)}>
                {actionButton(run.error.action, nameOf(run))}
              </Btn>
            )}
            {run.error.action === 'show_install' && (
              <Btn disabled={busy} onClick={() => void begin(run.input)}>
                Try again
              </Btn>
            )}
            <button type="button" className="aa-link" onClick={() => toIdle(null)}>
              Back
            </button>
          </div>
        </div>
      )}

      {run?.state === 'cancelled' && (
        <div className="aa-body">
          <h3 className="aa-title">Stopped. Nothing was added.</h3>
          <div className="aa-actions">
            <Btn onClick={() => toIdle(null)}>Back</Btn>
          </div>
        </div>
      )}

      {advanced && !run && <AddAgentAdvanced wizardApi={wizardApi} lastRun={lastRun} />}
    </section>
  );
}
