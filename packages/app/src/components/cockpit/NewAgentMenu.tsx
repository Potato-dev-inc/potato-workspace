// Body of the cockpit "+" menu. Three steps share one small panel:
//   1. pick an agent (an agent with user accounts gets a second step for the login);
//   2. the folder step: a project chip at the top opens Recent projects and "Choose folder…";
//   3. "Set up Git here" for a folder without Git, with the exact commands shown first.
// With Chat on, one Chat | Terminal switch sits under the title: it decides what a click on an agent starts (shells always
// open a terminal). An agent with no working chat shows the small NoChatPrompt under its row instead of failing.
// The Separate copy switch sits at the bottom of step 1. It starts OFF (the agent works in the folder the person
// selected); a remembered choice wins. Without Git it cannot be turned on: a one-line hint and "Set up Git here".
// The first row of step 1 is "Pick for me" (only with a `pick` API and a project). It asks which agent to start
// here, from the person's own history. It starts nothing: only a press on its Start button does.
import { SIGN_IN } from '../../lib/glossary';
import { t as tr, useT } from '../../i18n';
import { AgentLogo } from '../common/AgentLogo';
import { Fragment, useEffect, useState } from 'react';
import { accountsFor, needsAccountStep, pickableAccounts, rememberSignIn, rememberedSignIn, signInLabel, tauriAccountsApi, type Account, type AccountsApi } from '../../lib/accounts';
import { startFailure, type AcpAddable, type AcpChatApi, type AcpLaneAgent, type TerminalChatAgent } from '../../lib/acpChat';
import { blockOf, type AcpAddonApi } from '../../lib/acpAddon';
import type { StartMode } from '../../lib/newAgentStart';
import { NoChatPrompt, type AddChatKind, type NoChatAgent } from './NoChatPrompt';
import { HiddenAgentsEditor } from './newagent/HiddenAgentsEditor';
import { useHiddenAgents, visibleAgentEntries } from '../../lib/hiddenAgents';

/** Where a click on an agent goes: a terminal, a chat, a chat in a terminal, or the "no chat yet" prompt. */
type Route = 'terminal' | 'acp' | 'terminal_chat' | 'prompt';
import { shipApi, type GitInitPlan, type GitState, type RecentProject, type ShipApi } from '../../lib/ship-api';
import { realRecents, stateHint, supportsCopies } from '../../lib/ship-model';
import { earlyTitle, footerText, isEarly, pickHint, startable, startLabel, type PickApi, type PickResult, type PickState } from '../../lib/pick-for-me';
import '../../styles/cockpit-ship.css';
import '../../styles/cockpit-pick.css';
import '../../styles/cockpit-acp.css';

export interface LaunchEntry {
  type: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  /** A plain shell: it always opens a terminal. */
  shell?: boolean;
}

/** The folder a new agent will work in. */
export interface ProjectChoice {
  path: string;
  name: string;
  /** Git state when known; `undefined` means "assume it works" (the selected pane's folder). */
  state?: RecentProject['state'];
}

interface Props {
  entries: LaunchEntry[];
  readyAgents: Set<string>;
  onStart: (agentId: string, accountId?: string) => void;
  /** Called after an agent was started, so the host closes the menu. */
  onClose: () => void;
  accountsApi?: AccountsApi;
  /** The folder step. Without `onProject` the menu has no project chip (the old, plain menu). */
  project?: ProjectChoice | null;
  onProject?: (project: ProjectChoice) => void;
  /** The Separate copy switch. Without `onIsolated` it is not drawn. */
  isolated?: boolean;
  onIsolated?: (on: boolean) => void;
  ship?: ShipApi;
  /** "Pick for me". Without it, or without `project`, the row is not drawn. */
  pick?: PickApi;
  /** "More agents…": opens the Agent Store. Without it the row is not drawn. */
  onOpenStore?: () => void;
  /** "Start a mission…" (Preview, Labs). Without it the item is not drawn. */
  onStartMission?: () => void;
  /** "Tonight…" (Night Shift, Labs). Without it the item is not drawn. */
  onTonight?: () => void;
  /**
   * Chat sessions (ACP, Labs on). One Chat | Terminal switch at the top decides what a click starts (`mode`, saved by
   * the host through `onMode`). Shells always open a terminal. An agent with no working chat shows the small
   * "no chat yet" prompt instead of failing. Without `chat` (Labs off) the menu only starts terminals, with no switch.
   */
  chat?: {
    mode: StartMode;
    onMode: (mode: StartMode) => void;
    agents: readonly AcpLaneAgent[];
    /** Starts the chat and rejects with the backend's error. */
    onStart: (agentId: string, accountId?: string) => Promise<void>;
    /** Agents whose saved way to run is Chat (terminal). */
    terminalChat?: readonly TerminalChatAgent[];
    /** Starts the agent as Chat (terminal) and opens its Chat tab. Rejects with the backend's error. */
    onStartTerminal?: (agentId: string, accountId?: string) => Promise<void>;
    /** Agents with no chat yet: each gets a quiet "Set up chat" next to its name. */
    canAdd?: readonly AcpAddable[];
    /** The add-on status, install and progress (the Settings install). */
    addons?: AcpAddonApi;
    /** `acp_overlay_resolve`: the ways to give an agent a chat. */
    resolve?: AcpChatApi['overlayResolve'];
    /** Opens the add-chat dialog (on the adapter when `prefer` says so); the host starts the chat once it is added. */
    onAddChat?: (agent: NoChatAgent, prefer?: AddChatKind) => void;
  };
}

type Step = 'agents' | 'projects' | 'git' | 'pick' | 'edit';

/** The answer of "Pick for me" for one folder. `path` is the folder it was asked for, so an old answer is never shown. */
interface PickAnswer {
  path: string;
  result?: PickResult;
  failed?: boolean;
}

/** The one line under a switch that cannot be turned on: why, in plain words. */
function noGitHint(state: GitState | undefined): string {
  if (state === 'no_commits') return tr('newAgent.noGitFirst');
  if (state === 'missing') return tr('newAgent.noGitMissing');
  return tr('newAgent.noGitNone');
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

import { NeedTerminalsLine } from './NeedTerminalsLine';
import { splitByChat } from '../../lib/chatFirst';
import { useShowTerminals } from '../../lib/showTerminals';

export function NewAgentMenu({
  entries: allEntries,
  readyAgents,
  onStart,
  onClose,
  accountsApi = tauriAccountsApi,
  project,
  onProject,
  isolated = false,
  onIsolated,
  ship = shipApi,
  pick: pickApi,
  onOpenStore,
  onStartMission,
  onTonight,
  chat,
}: Props) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  // A sign-in lent by another PC ("Leo's PC (lent) · 2h 14m left") is listed next to my own, and its time left ticks.
  const [now, setNow] = useState(() => Date.now());
  const [picking, setPicking] = useState<LaunchEntry | null>(null);
  // The sign-in step was opened for a chat (a borrowed sign-in can start one too): which kind of chat to start.
  const [pickingChat, setPickingChat] = useState<'acp' | 'terminal_chat' | null>(null);
  const [step, setStep] = useState<Step>('agents');
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [plan, setPlan] = useState<GitInitPlan | null>(null);
  const [planFor, setPlanFor] = useState<RecentProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<PickAnswer | null>(null);
  const projectPath = project?.path ?? null;
  // Chat sessions: a failed start, and the agent whose "no chat yet" prompt is open.
  const [chatFail, setChatFail] = useState<{ agentId: string; sentence: string; terminalFallback: boolean } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [promptFor, setPromptFor] = useState<string | null>(null);
  // "Set up chat for another agent…": the pick list of agents with no chat yet (only those that can be started here).
  const [addPick, setAddPick] = useState(false);
  // Agents the person hid ("Edit list…"): the menu leaves them out. `allEntries` is the full list for the editor.
  const { hidden } = useHiddenAgents();
  // Terminals hidden: the menu lists only agents that can chat (and no shell), and every click starts a chat.
  const terminals = useShowTerminals();
  const chatFirst = !terminals;
  const visible = visibleAgentEntries(allEntries, hidden);
  const split = chatFirst ? splitByChat(visible, chat ? new Set(chat.agents.map((a) => a.id.toLowerCase())) : null) : null;
  const entries = split ? split.offered : visible;
  const needTerminals = split?.needTerminals ?? 0;
  const entryOf = (agentId: string): LaunchEntry | undefined => entries.find((e) => e.type === agentId);
  // The switch decides: Terminal (or no chat at all) starts a terminal; Chat starts the agent's chat, or asks what to do.
  const routeOf = (agentId: string): Route => {
    if (!chat || (chat.mode === 'terminal' && !chatFirst) || entryOf(agentId)?.shell) return 'terminal';
    if (!chatFirst && chat.terminalChat?.some((a) => a.id === agentId && a.chosen)) return 'terminal_chat';
    if (chat.agents.some((a) => a.id === agentId)) return 'acp';
    if (chat.terminalChat?.some((a) => a.id === agentId && a.chosen)) return 'terminal_chat';
    return chat.canAdd?.some((a) => a.id === agentId) ? 'prompt' : 'terminal';
  };

  useEffect(() => {
    let alive = true;
    accountsApi
      .list()
      .then((o) => alive && setAccounts(pickableAccounts(o)))
      .catch(() => undefined); // no accounts store (browser, old backend): the plain menu still works
    return () => {
      alive = false;
    };
  }, [accountsApi]);

  const anyBorrowed = accounts.some((a) => a.borrowed);
  useEffect(() => {
    if (!anyBorrowed) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(tick);
  }, [anyBorrowed]);
  // A lend that ran out while the menu was open is gone from the choices.
  const live = accounts.filter((a) => !a.borrowed || (a.ends_ms ?? 0) > now);

  const loadRecent = () => {
    ship
      .recent()
      .then((list) => setRecent(realRecents(list)))
      .catch(() => setRecent([]));
  };

  useEffect(() => {
    if (onProject) loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onProject]);

  // "Pick for me": asked once when the menu opens and again when the folder changes. The `alive` flag drops an
  // answer that arrives after the folder changed, so an old folder's pick is never shown. Nothing is started here.
  useEffect(() => {
    if (!pickApi || !projectPath) return undefined;
    let alive = true;
    setAnswer({ path: projectPath });
    pickApi
      .pick(projectPath)
      .then((result) => alive && setAnswer({ path: projectPath, result }))
      .catch(() => alive && setAnswer({ path: projectPath, failed: true }));
    return () => {
      alive = false;
    };
  }, [pickApi, projectPath]);

  // The pick state for the current folder only: 'loading', the answer, or 'failed' (then no row is drawn).
  const current = answer && answer.path === projectPath ? answer : null;
  let pickState: PickState | 'failed' | null = null;
  if (pickApi && projectPath) pickState = current?.result ?? (current?.failed ? 'failed' : 'loading');
  const pickResult = pickState !== null && pickState !== 'loading' && pickState !== 'failed' ? pickState : null;

  const start = (agentId: string, accountId?: string) => {
    // An agent with several sign-ins starts under the one used last next time, without the extra step.
    if (accountsFor(live, agentId).length > 0) rememberSignIn(agentId, accountId);
    onClose();
    onStart(agentId, accountId);
  };

  /** A terminal. An agent with several sign-ins uses the one from last time; `ask` (Shift+Enter, "Change") shows the choice. */
  const startTerminal = (agentId: string, ask = false) => {
    const entry = entryOf(agentId);
    if (entry && needsAccountStep(live, agentId)) {
      const last = ask ? null : rememberedSignIn(live, agentId, undefined, now);
      if (last) start(agentId, last.accountId);
      else setPicking(entry);
    } else start(agentId);
  };

  /** What a click on an agent does, by the switch. `accountId` (from "Pick for me") goes straight to the terminal. */
  const launch = (agentId: string, accountId?: string) => {
    const route = routeOf(agentId);
    setChatFail(null);
    if (route === 'acp' || route === 'terminal_chat') {
      // A chat has no login step, except when a sign-in lent by another PC is there to choose.
      const entry = entryOf(agentId);
      if (entry && live.some((a) => a.borrowed && a.agent_id === agentId)) {
        setPickingChat(route);
        setPicking(entry);
      } else void startChat(agentId, route);
    }
    else if (route === 'prompt') {
      setStep('agents');
      setPromptFor(agentId);
    } else if (accountId !== undefined) start(agentId, accountId);
    else startTerminal(agentId);
  };

  /** Starts the chat and closes the menu; rejects with the backend's error (the prompt shows it). */
  const runChat = async (agentId: string, how: 'acp' | 'terminal_chat', accountId?: string) => {
    if (!chat) return;
    if (how === 'acp') await (accountId === undefined ? chat.onStart(agentId) : chat.onStart(agentId, accountId));
    else await (accountId === undefined ? chat.onStartTerminal?.(agentId) : chat.onStartTerminal?.(agentId, accountId));
    onClose();
  };

  const startChat = async (agentId: string, how: 'acp' | 'terminal_chat', accountId?: string) => {
    if (!chat || chatBusy) return;
    setChatBusy(true);
    setChatFail(null);
    try {
      await runChat(agentId, how, accountId);
    } catch (err) {
      // The chat add-on is missing: the same small prompt as for an agent with no chat, not a paragraph.
      if (blockOf(err instanceof Error ? err.message : String(err)) === 'addon') {
        setPromptFor(agentId);
        return;
      }
      // A Chat (terminal) pane is a terminal already, so there is no "Start in terminal" fallback to offer.
      const failure = startFailure(err);
      setChatFail({ agentId, ...failure, terminalFallback: how === 'acp' && failure.terminalFallback });
    } finally {
      setChatBusy(false);
    }
  };

  const choose = (found: RecentProject) => {
    setError(null);
    if (found.state === 'missing') return;
    if (found.state === 'repo') {
      onProject?.({ path: found.path, name: found.name, state: found.state });
      setStep('agents');
      return;
    }
    // No Git (or no first snapshot): show what "Set up Git here" would do before it does anything.
    setPlanFor(found);
    setPlan(null);
    setStep('git');
    ship
      .gitInitPlan(found.path)
      .then(setPlan)
      .catch((err) => setError(errText(err)));
  };

  const pick = async () => {
    setError(null);
    try {
      const found = await ship.pickFolder();
      if (found) {
        loadRecent();
        choose(found);
      }
    } catch (err) {
      setError(errText(err));
    }
  };

  const setUpGit = async () => {
    if (!planFor) return;
    setBusy(true);
    setError(null);
    try {
      await ship.gitInit(planFor.path);
      onProject?.({ path: planFor.path, name: planFor.name, state: 'repo' });
      setStep('agents');
      loadRecent();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const withoutGit = () => {
    if (!planFor) return;
    onProject?.({ path: planFor.path, name: planFor.name, state: planFor.state });
    setStep('agents');
  };

  const forget = (found: RecentProject) => {
    ship
      .forget(found.path)
      .catch(() => undefined)
      .finally(loadRecent);
  };

  if (step === 'edit') {
    return <HiddenAgentsEditor entries={allEntries} onBack={() => setStep('agents')} />;
  }

  if (step === 'projects') {
    return (
      <>
        <div className="ck-menu-cap">{t('newAgent.menuRecent')}</div>
        {recent === null && <div className="ck-menu-note">{t('newAgent.menuLooking')}</div>}
        {recent?.length === 0 && <div className="ck-menu-note">{t('newAgent.menuNoProjects')}</div>}
        {recent?.map((p) => (
          <div key={p.path} className="ck-menu-project">
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item ck-menu-item--project"
              disabled={p.state === 'missing'}
              onClick={() => choose(p)}
              title={p.path}
            >
              <span className="ck-menu-project-main">
                <span className={p.state === 'missing' ? 'ck-menu-project-name is-dim' : 'ck-menu-project-name'}>{p.name}</span>
                <span className="ck-menu-project-path">{p.path}</span>
              </span>
              {stateHint(p.state) && <span className="ck-menu-hint">{stateHint(p.state)}</span>}
            </button>
            {p.state === 'missing' && (
              <button type="button" className="ck-menu-remove" aria-label={t('newAgent.menuRemoveAria', { name: p.name })} onClick={() => forget(p)}>
                {t('newAgent.menuRemove')}
              </button>
            )}
          </div>
        ))}
        <button type="button" role="menuitem" className="ck-menu-item" onClick={() => void pick()}>
          <span>{t('newAgent.menuChooseFolder')}</span>
        </button>
        {error && (
          <div className="ck-menu-note ck-menu-note--err" role="alert">
            {error}
          </div>
        )}
        <button type="button" role="menuitem" className="ck-menu-item" onClick={() => setStep('agents')}>
          <span>{t('newAgent.back')}</span>
        </button>
      </>
    );
  }

  if (step === 'git' && planFor) {
    return (
      <div className="ck-gitstep">
        <div className="ck-menu-cap">{planFor.name}</div>
        <p className="ck-gitstep-text">{t('newAgent.gitText')}</p>
        {plan ? (
          <>
            <p className="ck-gitstep-fine">
              {plan.too_big
                ? t('newAgent.gitTooBig')
                : t('newAgent.gitSaves', { count: plan.files })}
              {plan.gitignore.length > 0 && !plan.too_big && ` ${t('newAgent.gitIgnore')}`}{' '}
              {t('newAgent.gitPrivate')}
            </p>
            <details className="ck-gitstep-details">
              <summary>{t('newAgent.details')}</summary>
              <ul className="ck-gitstep-cmds" aria-label={t('newAgent.whatWillRun')}>
                {plan.commands.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          !error && <p className="ck-gitstep-fine">{t('newAgent.checkingFolder')}</p>
        )}
        {error && (
          <p className="ck-menu-note ck-menu-note--err" role="alert">
            {error}
          </p>
        )}
        <div className="ck-gitstep-actions">
          <button type="button" className="ck-btn ck-btn--primary" disabled={!plan || plan.too_big || busy} onClick={() => void setUpGit()}>
            {t('newAgent.setUpGit')}
          </button>
          <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={withoutGit}>
            {t('newAgent.notNow')}
          </button>
        </div>
        <button type="button" role="menuitem" className="ck-menu-item" onClick={() => setStep('projects')}>
          <span>{t('newAgent.back')}</span>
        </button>
      </div>
    );
  }

  if (step === 'pick' && pickResult) {
    // The pick panel: the name, one plain sentence, Start (only when it can really start), and "Why this one".
    const { choice } = pickResult;
    const canStart = startable(pickResult, entries);
    return (
      <div className="ck-pick">
        <div className="ck-menu-cap">{t('newAgent.pickForMe')}</div>
        {choice && <div className="ck-pick-name">{choice.label}</div>}
        {choice && isEarly(pickResult) && (
          <span className="ck-chip-label ck-pick-chip" title={earlyTitle()}>
            {t('newAgent.early')}
          </span>
        )}
        <p className="ck-pick-reason">{pickResult.reason}</p>
        {choice && !canStart && (
          <p className="ck-menu-note ck-menu-note--err" role="alert">
            {t('newAgent.cantStartHere', { name: choice.label })}
          </p>
        )}
        <div className="ck-pick-actions">
          {choice && canStart ? (
            <>
              <button type="button" className="ck-btn ck-btn--primary" autoFocus onClick={() => launch(choice.agentId, choice.accountId)}>
                {startLabel(pickResult)}
              </button>
              <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setStep('agents')}>
                {t('newAgent.chooseMyself')}
              </button>
            </>
          ) : (
            <button type="button" className="ck-btn ck-btn--secondary" autoFocus onClick={() => setStep('agents')}>
              {t('newAgent.back')}
            </button>
          )}
        </div>
        <details className="ck-pick-why">
          <summary>{t('newAgent.whyThis')}</summary>
          {pickResult.considered.map((c, i) => (
            <div key={`${c.label}-${i}`} className={c.state === 'skipped' ? 'ck-pick-line is-skipped' : 'ck-pick-line'}>
              <span>{c.label}</span>
              <span>{c.line}</span>
            </div>
          ))}
          {pickResult.notes.map((note) => (
            <p key={note} className="ck-pick-foot">
              {note}
            </p>
          ))}
          <p className="ck-pick-foot">{footerText()}</p>
        </details>
      </div>
    );
  }

  if (picking) {
    const chooseForChat = (accountId: string | undefined) => {
      const how = pickingChat!;
      setPicking(null);
      setPickingChat(null);
      void startChat(picking.type, how, accountId);
    };
    return (
      <>
        <div className="ck-menu-cap">{picking.label} · {SIGN_IN.action.toLowerCase()}</div>
        <button type="button" role="menuitem" className="ck-menu-item" onClick={() => (pickingChat ? chooseForChat(undefined) : start(picking.type))}>
          <span>{SIGN_IN.defaultOne}</span>
        </button>
        {accountsFor(live, picking.type).map((a) => (
          <button key={a.id} type="button" role="menuitem" className="ck-menu-item" disabled={!!pickingChat && a.borrowed && a.chat === false} title={pickingChat && a.borrowed && a.chat === false ? t('newAgent.lentNoChatTerminalLower') : undefined} onClick={() => (pickingChat ? chooseForChat(a.id) : start(picking.type, a.id))}>
            <span>{signInLabel(a, now)}</span>
          </button>
        ))}
        <button type="button" role="menuitem" className="ck-menu-item" onClick={() => {
            setPicking(null);
            setPickingChat(null);
          }}>
          <span>{t('newAgent.back')}</span>
        </button>
      </>
    );
  }

  const addPickList = chat ? (chat.canAdd ?? []).filter((a) => entries.some((e) => e.type === a.id && !e.disabled && !e.shell)) : [];
  const copiesOk = supportsCopies(project?.state);
  const canSetUpGit = project?.state === 'folder' || project?.state === 'no_commits';
  return (
    <>
      <div className="ck-menu-cap ck-menu-cap--row">
        <span>{t('newAgent.title')}</span>
        {onProject && (
          <button
            type="button"
            className="ck-chip-label ck-chip"
            aria-label={t('newAgent.projectLabel', { name: project?.name ?? t('newAgent.currentWord') })}
            aria-haspopup="menu"
            onClick={() => {
              loadRecent();
              setStep('projects');
            }}
          >
            <span className="ck-chip-name">{project?.name ?? t('newAgent.currentProject')}</span>
            <span aria-hidden="true">▾</span>
          </button>
        )}
      </div>
      {chat && !chatFirst && (
        <div className="ck-menu-startmode" data-testid="start-mode">
          <span id="ck-startmode-label">{t('newAgent.startIn')}</span>
          <div role="group" aria-labelledby="ck-startmode-label" className="ck-lane-seg">
            {(['chat', 'terminal'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="ck-lane-seg-btn"
                aria-pressed={chat.mode === m}
                onClick={() => {
                  setChatFail(null);
                  setPromptFor(null);
                  chat.onMode(m);
                }}
              >
                {m === 'chat' ? t('newAgent.chat') : t('newAgent.terminal')}
              </button>
            ))}
          </div>
        </div>
      )}
      {pickState !== null && pickState !== 'failed' && (
        <>
          <button type="button" role="menuitem" className="ck-menu-item" disabled={pickState === 'loading'} onClick={() => setStep('pick')}>
            <span>{t('newAgent.pickForMe')}</span>
            <span className="ck-menu-hint">{pickHint(pickState)}</span>
          </button>
          <div className="ck-menu-sep" />
        </>
      )}
      {entries.map((e) => {
        const route = routeOf(e.type);
        // An agent that will start as a chat skips the login step: a chat session has no login choice.
        const hasAccounts = route === 'terminal' && needsAccountStep(live, e.type);
        const last = hasAccounts ? rememberedSignIn(live, e.type, undefined, now) : null;
        const button = (
          <button
            key={e.type}
            type="button"
            role="menuitem"
            className="ck-menu-item"
            disabled={e.disabled || (route !== 'terminal' && chatBusy)}
            title={
              e.disabled
                ? `${e.disabledReason ? `${e.disabledReason}. ` : ''}${t('newAgent.onlyForTasks')}`
                : last
                  ? t('newAgent.startsWith', { label: last.label, noun: SIGN_IN.noun })
                  : e.disabledReason
            }
            onClick={(ev) => (hasAccounts && ev.shiftKey ? startTerminal(e.type, true) : launch(e.type))}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && ev.shiftKey && hasAccounts && !e.disabled) {
                ev.preventDefault();
                startTerminal(e.type, true);
              }
            }}
          >
            <AgentLogo id={e.type} name={e.label} size={14} decorative className="ck-menu-logo" />
            <span>{e.label}</span>
            {!e.disabled && hasAccounts && <span className="ck-menu-hint">{last ? `${last.label} ›` : t('newAgent.signIns', { n: accountsFor(live, e.type).length + 1 })}</span>}
            {!e.disabled && !hasAccounts && route === 'terminal' && readyAgents.has(e.type) && <span className="ck-menu-hint">{t('newAgent.ready')}</span>}
          </button>
        );
        // The remembered sign-in has a small way to pick another (Shift+Enter on the row does the same).
        const row =
          last && !e.disabled ? (
            <div key={e.type} className="ck-menu-split">
              {button}
              <button type="button" role="menuitem" className="ck-menu-change" aria-label={t('newAgent.changeFor', { noun: SIGN_IN.noun, name: e.label })} onClick={() => startTerminal(e.type, true)}>
                {t('newAgent.change')}
              </button>
            </div>
          ) : (
            button
          );
        // Only an agent that a click sends to the "no chat yet" prompt (Chat on) opens it. Setting up a chat from the list
        // is the link under the rows below.
        const addable = chat && !e.disabled && !e.shell ? chat.canAdd?.find((a) => a.id === e.type) : undefined;
        const open =
          promptFor === e.type && !e.disabled ? (
            <NoChatPrompt
              agent={{ id: e.type, label: e.label, reason: addable?.reason }}
              addons={chat?.addons}
              resolve={chat?.resolve}
              canAdd={!!addable && !addable.reason}
              onStartChat={(id) => runChat(id, 'acp')}
              onAddChat={(agent, prefer) => chat?.onAddChat?.(agent, prefer)}
              onUseTerminal={chatFirst ? undefined : () => startTerminal(e.type)}
            />
          ) : null;
        return (
          <Fragment key={e.type}>
            {row}
            {open}
          </Fragment>
        );
      })}
      {chatFail && (
        <div className="ck-menu-note ck-menu-note--err ck-menu-note--row" role="alert" data-testid="chat-start-failed">
          <span>{chatFail.sentence}</span>
          {chatFail.terminalFallback && !chatFirst && (
            <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => start(chatFail.agentId)}>
              {t('newAgent.startInTerminal')}
            </button>
          )}
        </div>
      )}
      <NeedTerminalsLine count={needTerminals} onOpen={onClose} />
      {addPickList.length > 0 && chat?.onAddChat && (
        <>
          <button type="button" className="ck-menu-setup" aria-expanded={addPick} onClick={() => setAddPick((v) => !v)}>
            {t('newAgent.setUpChatOther')}
          </button>
          {addPick &&
            addPickList.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                data-testid={`add-pick-${a.id}`}
                className="ck-menu-item"
                onClick={() => {
                  setAddPick(false);
                  chat?.onAddChat?.({ id: a.id, label: a.label, reason: a.reason });
                }}
              >
                <span>{a.label}</span>
              </button>
            ))}
        </>
      )}
      {onIsolated && (
        <>
          <div className="ck-menu-toggle" title={t('newAgent.copyTip')}>
            <span id="ck-sepcopy-label">{t('newAgent.copy')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={isolated && copiesOk}
              aria-disabled={!copiesOk}
              aria-labelledby="ck-sepcopy-label"
              className="ck-switch"
              disabled={!copiesOk}
              onClick={() => onIsolated(!isolated)}
            >
              <span className="ck-switch-knob" />
            </button>
          </div>
          {!copiesOk ? (
            <div className="ck-menu-note ck-menu-note--row">
              <span>{noGitHint(project?.state)}</span>
              {project && canSetUpGit && (
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => choose({ ...project, state: project.state as GitState, last_used_ms: 0 })}>
                  {t('newAgent.setUpGit')}
                </button>
              )}
            </div>
          ) : (
            <div
              className="ck-menu-note"
              title={isolated ? t('newAgent.fromBranchTip') : undefined}
            >
              {isolated ? t('newAgent.fromBranch') : t('newAgent.worksHere')}
            </div>
          )}
        </>
      )}
      {onOpenStore && (
        <button type="button" role="menuitem" className="ck-menu-item" onClick={onOpenStore}>
          <span>{t('newAgent.moreAgents')}</span>
        </button>
      )}
      {(onStartMission || onTonight) && <div className="ck-menu-sep" />}
      {onStartMission && (
        <button type="button" role="menuitem" className="ck-menu-item" onClick={onStartMission}>
          <span>{t('newAgent.startMission')}</span>
          <span className="ck-menu-hint">{t('newAgent.preview')}</span>
        </button>
      )}
      {onTonight && (
        <button type="button" role="menuitem" className="ck-menu-item" onClick={onTonight}>
          <span>{t('newAgent.tonight')}</span>
          <span className="ck-menu-hint">{t('newAgent.nightShift')}</span>
        </button>
      )}
      <div className="ck-menu-sep" />
      <button type="button" className="ck-menu-edit-agents" onClick={() => setStep('edit')}>
        {t('newAgent.editList')}
      </button>
    </>
  );
}
