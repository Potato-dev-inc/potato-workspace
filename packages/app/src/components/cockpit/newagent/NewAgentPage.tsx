// The New agent page: a greeting, one big message box, and under it the choices that matter (folder, agent, how it
// runs). Enter starts the agent in that folder with the message through the same start path as the "+" menu.
// It takes plain data and callbacks; `NewAgentHost` (next to it) wires them to the cockpit. Choices the app has no
// backing for (a permission mode, a model, an effort) are not drawn: nothing here is a stand-in.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { errorSentence } from '../../../lib/sayError';
import { growBox, refusePaste } from '../../../lib/bigText';
import { registerFileDrop } from '../../../lib/fileDrop';
import type { Account } from '../../../lib/accounts';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { RecentProject } from '../../../lib/ship-api';
import { addonFor, needsInstall, tauriAcpAddonApi, type AcpAddonApi } from '../../../lib/acpAddon';
import { useAcpAddons } from '../../../hooks/useAcpAddons';
import { useDismissable } from '../../../hooks/useDismissable';
import { Menu as SharedMenu, useLayerHost } from '../../common/Floating';
import { AddonPrompt } from '../../acp/AddonPrompt';
import { SignInCard } from '../../acp/SignInCard';
import { useFarPlan, type FarPlanOf } from './useFarPlan';
import { useCopyOffered } from '../../../lib/copyOffer';
import { lastRealFolder, projectOfCwd, readStoredCopyPreference, supportsCopies, supportsChatCopy, isPlainCopyFolder, writeCopyPreference, copyDefault } from '../../../lib/ship-model';
import { folderName, pathKey, useSidebarProjects } from '../../../lib/sidebarProjects';
import { IconChevronDown, IconFolder, IconPlus, IconSpark } from '../Icons';
import { useT } from '../../../i18n';
import { splitByChat } from '../../../lib/chatFirst';
import { useShowTerminals } from '../../../lib/showTerminals';
import { NeedTerminalsLine } from '../NeedTerminalsLine';
import type { ProjectChoice } from '../NewAgentMenu';
import { gitStateOf, remotePathOf } from '../../../lib/runtime/remoteNewAgent';
import { useHost } from '../../../lib/host/context';
import { ownLoginApiFor, type OwnLogin } from '../../settings/agents/ownSignIn';
import { agentReadiness } from '../../../lib/agentReadiness';
import { useTestMemory } from '../../../lib/useAgentReadiness';
import { LEND_MINE } from '../../../lib/host/ownAgents';
import { hostNewAgentSources, useHostAgents } from '../../../lib/host/newAgentSources';
import { tauriNewAgentApi, type HomeSettings, type NewAgentApi, type WorkflowChoice } from './api';
import { prettyModel } from '../../crews/modelNames';
import { openSettingsAt } from '../../../lib/openSettingsAt';
import { HomeCards, type CardData } from './HomeCards';
import { GettingStarted } from './GettingStarted';
import { ContinueCard, type ContinueYesterdayProps } from './ContinueCard';
import {
  EXAMPLE_MS,
  addCard,
  agentChoices,
  canAdd,
  chatAvailable,
  defaultChoice,
  defaultRunAs,
  exampleAt,
  hintOf,
  nextExample,
  parseRunAs,
  sendBlock,
  startingModel,
  withPaths,
  type AgentChoice,
  type HomeCard,
  type LaneView,
  type RunAs,
  type StartRequest,
  workflowSummary,
} from './model';
import { AgentLogo } from '../../common/AgentLogo';
import { DisabledReason } from '../../common/DisabledReason';
import { ModelPicker } from '../../common/ModelPicker';
import { readPickedModel, tauriAgentDefaultsApi, presetOnly, tauriModelOptionsApi, useAgentDefaults, useModelOptions, writePickedModel, type AgentDefaultsApi, type ModelOptionsApi } from '../../../lib/modelOptions';
import { isStartBlock } from './start';
import '../../../styles/cockpit-newagent.css';
import { Starters } from './Starters';
import { takeNewAgentDraft } from '../../../lib/team-pass-bridge';
import { PinnedLine, usePinnedRules } from './PinnedLine';
import { tauriAgentRulesApi, type AgentRulesApi } from '../../../lib/agentRules';

const REMEMBER_KEY = 'pm.newagent.agent';
const REMEMBER_RUN_KEY = 'pm.newagent.runAs';

// Each remembered choice is a convenience: storage can be blocked, and a bad value is simply ignored.
function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}
function remember(key: string): void {
  try {
    localStorage.setItem(REMEMBER_KEY, key);
  } catch {
    /* storage can be blocked: the choice just is not remembered */
  }
}
function rememberedRunAs(): RunAs | null {
  try {
    return parseRunAs(localStorage.getItem(REMEMBER_RUN_KEY));
  } catch {
    return null;
  }
}
function rememberRunAs(mode: RunAs): void {
  try {
    localStorage.setItem(REMEMBER_RUN_KEY, mode);
  } catch {
    /* a convenience only */
  }
}

// The page leaves for the sign-in terminal and comes back: what was typed and chosen is kept for that one trip.
const SIGNIN_KEY = 'pm.newagent.signin';

interface SignInTrip {
  pickKey: string;
  folder?: { path: string; name: string };
  prompt: string;
}

function saveTrip(trip: SignInTrip): void {
  try {
    sessionStorage.setItem(SIGNIN_KEY, JSON.stringify(trip));
  } catch {
    /* storage can be blocked: the text is just not kept */
  }
}
function takeTrip(): SignInTrip | null {
  try {
    const raw = sessionStorage.getItem(SIGNIN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SIGNIN_KEY);
    const trip = JSON.parse(raw) as Partial<SignInTrip>;
    if (typeof trip.pickKey !== 'string' || typeof trip.prompt !== 'string') return null;
    const folder = trip.folder && typeof trip.folder.path === 'string' && typeof trip.folder.name === 'string' ? trip.folder : undefined;
    return { pickKey: trip.pickKey, prompt: trip.prompt, folder };
  } catch {
    return null;
  }
}

export interface PaneBrief {
  id: string;
  title: string;
  status: string;
}

/** What the page knows about the other PC whose data it shows. */
export interface RemoteInfo {
  deviceName: string;
  terminals: boolean;
  /** Why Start is off for this PC before anything is typed (it lets this PC only watch), or null. */
  blocked: string | null;
  /** This far PC starts a chat on a separate copy (its `acp_chat_start` row), so "Work on a copy" is offered. */
  copy?: boolean;
  /** The agent and folder are picked: the far PC may warm that agent's chat program. */
  onWarm?: (agentId: string, folder: string) => void;
  /** What a plain start of an agent there runs on (its own sign-in, or the lend this PC made). */
  plan?: FarPlanOf;
  /** The far PC has not let this PC work on it: in place of Start, one line, and a button that really asks the person there (`ask`). */
  agentsOff?: { line: string; ask?: AgentsAsk };
  /** "Use my own agents": this PC's name and the agents of this PC that can be lent to that PC (their chats run there, on my sign-in here). */
  mine?: { thisName: string; agents: { agentId: string; label: string; chat: boolean }[] };
}

/** "Ask <PC> to allow agents": a card is put on the far PC; nothing is granted until its person says yes. */
export interface AgentsAsk {
  state: 'idle' | 'asking' | 'asked' | 'error';
  label: string;
  askingLabel: string;
  /** `asked`: "Asked. Waiting for a yes at <PC>." */
  askedLine: string;
  /** `error`: what went wrong, said honestly. */
  error: string | null;
  onAsk: () => void;
}

/** One other PC in the project picker: its folders under its own name. */
export interface DevicePickerGroup {
  node: string;
  name: string;
  /** Why the PC cannot be used now (offline, asleep, not let in): the group is greyed and says so. Null: usable. */
  why: string | null;
  /** How reachable it is: an offline (or asleep) PC reads "<PC> is offline"; one that does not let this PC in says why. */
  status: 'online' | 'offline' | 'cant';
  state: 'loading' | 'ready' | 'failed' | 'away';
  projects: { id: string; name: string; state: string }[];
}

/**
 * The project picker grouped by device: This PC, then each other PC under its name, each ending with its own "Add project". Picking
 * a folder of another PC starts the agent there (the page for that PC takes over, `lib/runtime/remoteNewAgent.ts`).
 */
export interface DevicePicker {
  /** This PC's own name: its group reads "<name> (this PC)". */
  thisName: string;
  groups: DevicePickerGroup[];
  /** The device whose page this is, or null for This PC. */
  currentNode: string | null;
  /** The picker was opened: read the PCs' folders again. */
  onOpen: () => void;
  /** A folder of another PC was picked. */
  onPickRemote: (node: string, project: { id: string; name: string; state: string }) => void;
  /** A folder of This PC was picked while another PC's page is showing. */
  onPickLocal: (project: ProjectChoice) => void;
  /** "Add project" of another PC: "Open a folder on <PC>". */
  onAddRemote: (node: string) => void;
}

export interface NewAgentPageProps {
  /** Absent: the agents of the PC this page is shown on (`useHostAgents`). */
  agents?: readonly AgentDescriptor[];
  /** Every agent pane, for the Running and Needs you cards. */
  panes: readonly PaneBrief[];
  /** Panes with something waiting on the person. */
  needs: readonly PaneBrief[];
  /** The folder of the pane that is selected, if any: the first guess for the folder. */
  selectedCwd?: string | null;
  /** The project to start in (from a project's "+" in the sidebar). Beats the last-used project. */
  project?: { path: string; name: string } | null;
  /** The folders agents are running in now: offered in the Project picker when they are not saved projects. */
  runningFolders?: readonly string[];
  api?: NewAgentApi;
  /** The chat add-ons (install state and install). */
  addonApi?: AcpAddonApi;
  /** The models each agent can start on. */
  modelApi?: ModelOptionsApi;
  /** The Default model saved per agent in Settings; the picker starts on it when there is no last pick. */
  defaultsApi?: AgentDefaultsApi;
  /** The pins (Settings > Agents > Rules for agents): shown under the box, and a pinned model starts the agent. */
  rulesApi?: Pick<AgentRulesApi, 'effective'>;
  /** Opens the agent's own terminal pane in `folder`, where the person signs in. Absent: the card only explains. */
  onSignIn?: (agentId: string, folder?: string) => Promise<unknown> | void;
  /** Hand the request to whoever starts agents. May resolve later; the page is busy until then. */
  onStart: (request: StartRequest) => Promise<unknown> | void;
  onOpenPane: (paneId: string) => void;
  /** "Set up an agent": opens the agent doctor. Absent: no such row. */
  onSetUp?: () => void;
  /** "Continue where you left off": the chats that were open last time. Absent: no card. */
  continueYesterday?: Omit<ContinueYesterdayProps, 'onFresh'>;
  /** Drawn first in the composer row, before the project pill (the Where pill, with Labs Devices on). */
  leading?: ReactNode;
  /**
   * Another PC's data is plugged in (`api`, `agents` ... come from it, `lib/runtime/remoteNewAgent.ts`): the page is the same, with a
   * small "on <device>" label. What only exists on this PC (the system folder and file dialogs, copies, the home cards, the getting
   * started card, what this PC remembers) is left out, in the same places.
   */
  remote?: RemoteInfo | null;
  /** Devices (Labs): the project picker lists This PC and each other PC as groups. Absent: the picker is as it was. */
  devices?: DevicePicker | null;
  /** The folder this page opens on (a project picked in the grouped picker on the other page). */
  startFolder?: ProjectChoice | null;
  /** A Linux distro of this PC is picked in "Run in": agents start there as terminals; one that cannot run there is greyed with the reason. */
  place?: { name: string; whyNot: (agentId: string) => string | null } | null;
}

type Menu = 'plus' | 'folder' | 'agent' | 'workflow' | null;

export function NewAgentPage({ agents: agentsGiven, panes, needs, selectedCwd = null, project = null, runningFolders = [], api: apiGiven, addonApi: addonGiven, modelApi: modelGiven, defaultsApi: defaultsGiven, rulesApi: rulesGiven, onSignIn, onStart, onOpenPane, onSetUp, continueYesterday, leading = null, remote = null, devices = null, startFolder = null, place = null }: NewAgentPageProps) {
  const t = useT();
  // What this page reads comes from the PC it is shown on (`useHost()`): this PC's own commands, or another PC's far call rows.
  const host = useHost();
  const own = useMemo(() => hostNewAgentSources(host), [host]);
  const hostAgents = useHostAgents(host);
  const agents = agentsGiven ?? hostAgents;
  const api = apiGiven ?? own?.api ?? tauriNewAgentApi;
  const addonApi = addonGiven ?? own?.addonApi ?? tauriAcpAddonApi;
  const modelApi = modelGiven ?? own?.modelApi ?? tauriModelOptionsApi;
  const defaultsApi = defaultsGiven ?? own?.defaultsApi ?? tauriAgentDefaultsApi;
  const rulesApi = rulesGiven ?? own?.rulesApi ?? tauriAgentRulesApi;
  const [prompt, setPrompt] = useState('');
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [exampleIdx, setExampleIdx] = useState(0);
  const [menu, setMenu] = useState<Menu>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [home, setHome] = useState<HomeSettings>({ name: '', cards: [] });
  const [accounts, setAccounts] = useState<Account[]>([]);
  // This PC's own logins (the same read Overview and Settings > Agents use): a signed-out one is never called "ready".
  const [ownLogins, setOwnLogins] = useState<OwnLogin[] | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => ownLoginApiFor(host).states(false))
      .then((rows) => live && setOwnLogins(rows))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [host]);
  const [lanes, setLanes] = useState<LaneView | null>(null);
  const [recent, setRecent] = useState<RecentProject[] | null>(null);
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null);
  const [chosenFolder, setChosenFolder] = useState<ProjectChoice | null>(() => (project ? { path: project.path, name: project.name } : startFolder));
  const [lastProject] = useState<ProjectChoice | null>(() => (remote ? null : readLastProject()));
  // The remembered project turned out to be gone (its folder is missing): it is skipped quietly.
  const [goneFolder, setGoneFolder] = useState<string | null>(null);
  const saved = useSidebarProjects();
  const [looked, setLooked] = useState<{ path: string; state: RecentProject['state'] } | null>(null);
  const [pickKey, setPickKey] = useState<string | null>(null);
  const [runPick, setRunPick] = useState<RunAs | null>(rememberedRunAs);
  // The agent whose chat start said "sign in first"; the card shows until the person says they are signed in.
  const [signInFor, setSignInFor] = useState<string | null>(null);
  const addons = useAcpAddons(addonApi);
  // Labs "Workflows": null while the switch is off (or on an older build).
  const [workflows, setWorkflows] = useState<WorkflowChoice[] | null>(null);
  const [wfHidden, setWfHidden] = useState(0);
  const [wfSlug, setWfSlug] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Back from the sign-in terminal: the message, agent and folder are as they were, and the card asks to try again.
  useEffect(() => {
    if (remote) return; // a sign-in trip back belongs to this PC's page
    const trip = takeTrip();
    if (!trip) return;
    setPrompt(trip.prompt);
    setPickKey(trip.pickKey);
    setRunPick('chat');
    if (trip.folder) setChosenFolder({ path: trip.folder.path, name: trip.folder.name });
    setSignInFor(trip.pickKey.split(':')[0]);
  }, []);

  // A task a teammate passed: "Start…" leaves its words here. They go in the box only. The person reads and presses Send.
  const [fromTask, setFromTask] = useState<string | null>(null);
  useEffect(() => {
    if (remote) return; // a task a teammate passed is for this PC's page
    const d = takeNewAgentDraft();
    if (!d) return;
    setPrompt(d.text);
    setFromTask(d.from);
    if (d.folder) setChosenFolder({ path: d.folder, name: folderName(d.folder) });
  }, []);

  // Another PC's folders can become (or stop being) a Git repo while this page is open: read them again when the window is back and every 30 s.
  const isFar = remote !== null;
  useEffect(() => {
    if (!isFar) return undefined;
    let live = true;
    const again = () => void api.recent().then((list) => live && setRecent(list)).catch(() => undefined);
    const timer = setInterval(again, 30_000);
    window.addEventListener('focus', again);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', again);
    };
  }, [api, isFar]);

  // What the page reads once. Every read may fail (a browser preview, an older build): the page still works.
  useEffect(() => {
    let live = true;
    const ok = <T,>(p: Promise<T>, set: (v: T) => void) => p.then((v) => live && set(v)).catch(() => undefined);
    void ok(api.loadHome(), setHome);
    void ok(api.accounts(), setAccounts);
    void ok(api.lanes(), setLanes);
    void ok(api.recent(), setRecent);
    void ok(api.defaultFolder(), setDefaultFolder);
    if (api.workflows) void ok(api.workflows(), setWorkflows);
    if (api.workflowsHidden) void ok(api.workflowsHidden(), setWfHidden);
    let off: (() => void) | undefined;
    api
      .onHomeChanged((next) => live && setHome((h) => ({ ...h, ...next })))
      .then((stop) => (live ? (off = stop) : stop()))
      .catch(() => undefined);
    return () => {
      live = false;
      off?.();
    };
  }, [api]);

  // The example changes while the box is empty.
  useEffect(() => {
    if (prompt) return undefined;
    const timer = window.setInterval(() => setExampleIdx((i) => nextExample(i)), EXAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [prompt]);

  // One shared closing rule (outside press, Escape, focus leaving, page scroll) closes the open menu.
  const menuRoot = useRef<HTMLDivElement>(null);
  // The chip menus are drawn in the top layer: a press in one of them is inside the composer.
  const layers = useLayerHost();
  useDismissable(menu !== null, {
    inside: [menuRoot],
    extra: layers.extra,
    onDismiss: (why) => {
      setMenu(null);
      if (why === 'escape') area.current?.focus();
    },
  });

  // The sidebar's "+" on a project opens the page with that project: take it again when it changes.
  useEffect(() => {
    if (project) setChosenFolder({ path: project.path, name: project.name });
  }, [project?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- the folder: the person's pick, else the project passed in (same thing), else the last-used project, else the selected pane's project, else the newest recent one, else the default -----
  const usableLast = lastProject && lastProject.path !== goneFolder ? lastProject : null;
  const base: ProjectChoice | null = chosenFolder ?? usableLast ?? projectOfCwd(selectedCwd) ?? lastRealFolder(recent ?? []) ?? projectOfCwd(defaultFolder);
  useEffect(() => {
    if (!base || base.state) return undefined;
    let live = true;
    api
      .gitState(base.path)
      .then((state) => {
        if (!live) return;
        setLooked({ path: base.path, state });
        if (state === 'missing') setGoneFolder(base.path);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, base?.path, base?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // A far project's state comes from the far PC's list, which is read again (above): its newest word beats the one the folder was picked with.
  const freshState = remote && base ? (recent ?? []).find((r) => r.path === base.path)?.state : undefined;
  const folder: ProjectChoice | null = base ? { ...base, state: freshState ?? base.state ?? (looked?.path === base.path ? looked.state : undefined) } : null;
  const folderKey = folder?.path ?? null;
  const [storedCopy, setStoredCopy] = useState(() => readStoredCopyPreference(folderKey));
  useEffect(() => setStoredCopy(readStoredCopyPreference(folderKey)), [folderKey]);
  const copiesOk = supportsCopies(folder?.state);

  // ----- the agent -----
  // Terminals hidden: only agents that can chat are listed (the rest are counted in one quiet line), and every start is a chat.
  const terminals = useShowTerminals();
  // Another PC's terminal is offered only when this PC shows terminals too AND that PC does (its own setting guards the start).
  const chatFirst = place ? false : remote ? !(terminals && remote.terminals) : !terminals;
  const chatIds = useMemo(() => (lanes?.labsEnabled ? new Set(lanes.agents.filter((a) => !a.disabled).map((a) => a.id.toLowerCase())) : null), [lanes]);
  const needTerminals = useMemo(
    () => (chatFirst ? splitByChat(agents.map((a) => ({ type: a.id, shell: a.kind === 'shell', disabled: !a.modes.visible })), chatIds).needTerminals : 0),
    [chatFirst, agents, chatIds],
  );
  // "Use my own agents" (another PC's page only): this PC's agents that can be lent, one more sign-in each. They can start even when the far PC does not
  // have the agent yet (Start then asks to install it there first).
  const mineAccounts = useMemo<Account[]>(() => (remote?.mine ? remote.mine.agents.map((a) => ({ id: LEND_MINE, agent_id: a.agentId, label: t('myAgents.account', { name: remote.mine!.thisName }), home: '', borrowed: true, chat: a.chat })) : []), [remote?.mine, t]);
  const tests = useTestMemory();
  const choices = useMemo(() => {
    const all = agentChoices(agents, place ? [] : remote ? [...accounts, ...mineAccounts] : accounts).map((c) => {
      const why = place?.whyNot(c.agentId) ?? null;
      if (c.accountId === LEND_MINE) return { ...c, state: 'ready' as const, hint: t('myAgents.rowHint') };
      if (why) return { ...c, state: 'unavailable' as const, hint: why };
      // A plain start runs on this PC's own login; when that is signed out it runs on a lend this PC holds, else it cannot work.
      if (!c.accountId && c.state === 'ready' && ownLogins && agentReadiness(c.agentId, { logins: ownLogins, tests }).state === 'needs_sign_in') {
        return { ...c, note: accounts.some((a) => a.borrowed && a.agent_id === c.agentId) ? t('myAgents.hintBorrowed') : t('myAgents.hintSignedOut') };
      }
      return c;
    });
    // A lent sign-in of an agent with no chat on one cannot start a chat either.
    return chatFirst && chatIds ? all.filter((c) => chatIds.has(c.agentId.toLowerCase()) && !c.noChat) : all;
  }, [agents, accounts, mineAccounts, remote, chatFirst, chatIds, place, t, ownLogins, tests]);
  const plainChoices = useMemo(() => choices.filter((c) => c.accountId !== LEND_MINE), [choices]);
  const myChoices = useMemo(() => choices.filter((c) => c.accountId === LEND_MINE), [choices]);
  // The remembered agent and sign-in (the key holds both). A key that is gone, or not ready, falls back to the first ready one.
  // A picked workflow decides the agent and the model: the front's. The pickers stay on the page, locked.
  // Linux places start a plain terminal: no workflow, no sign-in choice, no copy, no attachments (nothing is dropped silently, none is offered).
  const wf = place ? null : workflows?.find((w) => w.slug === wfSlug) ?? null;
  const wfAgent = wf ? (choices.find((c) => c.agentId.toLowerCase() === wf.plan.front_agent.toLowerCase()) ?? null) : null;
  const choice: AgentChoice | null = wf ? wfAgent : ((pickKey ? choices.find((c) => c.key === pickKey) : undefined) ?? defaultChoice(choices, remembered()));
  const chatLane = chatAvailable(lanes, choice?.agentId ?? null);
  // A lent sign-in of an agent with no chat on one: Chat is shown off, with the reason, instead of failing after the click.
  const lendNoChat = chatLane && !!choice?.noChat;
  const canChat = chatLane && !lendNoChat && !place;
  // Chat is the default when the agent's chat add-on is in place; otherwise the page starts a terminal.
  const chatAddon = addonFor(addons.byAgent, choice?.agentId);
  // Another PC starts a chat unless the person picked Terminal (switch shown only when both PCs show terminals). With terminals hidden, chat is the only way.
  const runAs: RunAs = canChat ? (chatFirst ? 'chat' : remote ? (runPick === 'terminal' ? 'terminal' : 'chat') : (runPick ?? defaultRunAs(lanes, choice?.agentId ?? null))) : 'terminal';
  // "Work on a copy": a terminal needs Git; a chat also works on a plain trial copy of a folder without Git.
  const canCopy = runAs === 'chat' ? supportsChatCopy(folder?.state) : !remote && copiesOk;
  // Settings > Agents can hide the option (all projects, or one). Hidden means off: a remembered "on" never starts a copy.
  // Another PC offers it when it has the row that starts a chat on a copy (`remote.copy`); its Add files stays off (a path on this PC means nothing there).
  const copyOffered = useCopyOffered(folderKey) && (!remote || remote.copy === true) && !place;
  const isolated = copyOffered && copyDefault(storedCopy) && canCopy;

  // ----- the model: the last pick per agent and sign-in (this page only), else the agent's Default model from Settings -----
  const liveList = useModelOptions(choice?.agentId ?? null, modelApi, !remote);
  // A terminal pane takes the launch flag's own names; only a chat is told the agent's live ids.
  const modelList: typeof liveList = runAs === 'terminal' && liveList.status === 'ready' ? { status: 'ready', options: presetOnly(liveList.options) } : liveList;
  const modelSlot = choice ? `${choice.agentId}|${choice.accountId ?? ''}` : '';
  const [modelPick, setModelPick] = useState<{ slot: string; value: string } | null>(null);
  // What was pinned for this agent in this project: a pinned model starts it unless the person picks another here.
  const pins = usePinnedRules(choice?.agentId ?? null, folder?.path ?? null, rulesApi);
  const storedModel = pins?.model || (choice && !remote ? readPickedModel(choice.agentId, choice.accountId) : '');
  const agentDefaults = useAgentDefaults(defaultsApi);
  const model = wf ? (wf.plan.front_model ?? '') : modelPick?.slot === modelSlot ? modelPick.value : startingModel(storedModel, choice ? (agentDefaults[choice.agentId.toLowerCase()] ?? '') : '', modelList.status === 'ready' ? modelList.options : null);
  // A chat sets its model once it starts, so it always can. A terminal pane needs the agent's own launch flag.
  const showModel = !!choice && !place && (runAs === 'chat' || (modelList.status === 'ready' && modelList.options.terminal));

  const addon = runAs === 'chat' ? chatAddon : undefined;
  const installFirst = needsInstall(addon);
  const placeWhy = place && choice ? place.whyNot(choice.agentId) : null;
  // Another PC, a plain start: what it will run on. A chat that cannot answer (its login is out and nothing is lent) is not started.
  const farPlan = useFarPlan(remote?.plan, remote && choice && !choice.accountId ? choice.agentId : null);
  const farNoSignIn = !!remote && !!choice && !choice.accountId && runAs === 'chat' && farPlan?.signedOut === true && !farPlan.lend;
  const block = remote?.blocked ?? (placeWhy ? `${choice?.label}: ${placeWhy}` : null) ?? sendBlock({ prompt, choice, runAs, folder: folder?.path ?? null, busy }) ?? (chatFirst && choice && !canChat ? t('newAgent.blockNoAgent') : null) ?? (installFirst ? t('newAgent.installFirst') : null) ?? (farNoSignIn ? t('newAgent.remote.notSignedIn', { name: remote!.deviceName, agent: choice!.agentLabel ?? choice!.label }) : null);
  const signInCard = runAs === 'chat' && choice && signInFor !== null && signInFor.toLowerCase() === choice.agentId.toLowerCase();
  const example = exampleAt(exampleIdx);

  // Another PC: once an agent and a folder are picked for a chat, that PC warms the agent up so Start finds it ready.
  const warmAgent = remote && runAs === 'chat' && !remote.blocked && choice && choice.accountId !== LEND_MINE && folder ? `${choice.agentId}|${folder.path}` : null;
  useEffect(() => {
    if (!warmAgent || !remote?.onWarm || !choice || !folder) return;
    remote.onWarm(choice.agentId, folder.path);
    // Only a change of agent or folder asks again.
  }, [warmAgent]); // eslint-disable-line react-hooks/exhaustive-deps

  // One row of the agent picker (a plain agent or one under a sign-in). The same row is used in "Use my own agents".
  const renderChoice = (c: AgentChoice, mine = false) => (
      <button
        key={c.key}
        type="button"
        role="menuitemradio"
        aria-checked={choice?.key === c.key}
        className="ck-na-item"
        disabled={c.state === 'unavailable'}
        title={c.state === 'ready' ? undefined : (place?.whyNot(c.agentId) ?? hintOf(c.state))}
        onClick={() => {
          setPickKey(c.key);
          if (!remote) remember(c.key);
          setMenu(null);
          area.current?.focus();
        }}
      >
        <span className="ck-na-item-main">
          <span className="ck-na-item-row">
            <span className={`ck-na-dot is-${c.state}`} aria-hidden="true" />
            <AgentLogo id={c.agentId} name={c.label} size={13} decorative className="ck-na-logo" />
            <span>{mine ? t('myAgents.row', { agent: c.agentLabel ?? c.label }) : c.label}</span>
          </span>
        </span>
        <span className="ck-na-item-hint">{place?.whyNot(c.agentId) ?? (mine ? c.hint : (c.note ?? hintOf(c.state)))}</span>
      </button>
  );

  const send = async () => {
    if (block || !choice) return;
    setError(null);
    setBusy(true);
    if (!wf && !remote) remember(choice.key);
    try {
      // A workflow starts its front with the brief first, then what the person asked.
      let first = prompt.trim();
      let workflow: { slug: string; name: string; front: string; brief: string } | undefined;
      if (wf) {
        if (!folder?.path || !api.workflowPlan) throw new Error(t('newAgent.wf.planFailed'));
        const plan = await api.workflowPlan(wf.slug, folder.path, first).catch((e: unknown) => {
          throw new Error(errorSentence(e, t('newAgent.wf.planFailed')));
        });
        first = plan.first_message;
        workflow = { slug: wf.slug, name: plan.name, front: plan.front_name, brief: plan.brief };
      }
      const result = await onStart({
        agentId: choice.agentId,
        accountId: choice.accountId,
        folder: folder?.path,
        isolated,
        runAs,
        prompt: first,
        ...(workflow ? { workflow } : {}),
        ...(showModel && model ? { model } : {}),
      });
      // Whole-horde mode: the helpers start right after the front, under its chat.
      if (wf && wf.plan.start_mode === 'horde' && folder?.path && typeof result === 'string' && api.workflowHelpers) {
        const why = await api.workflowHelpers(wf.slug, folder.path, result).catch((e: unknown) => errorSentence(e, t('newAgent.wf.planFailed')));
        if (why && alive.current) setError(t('newAgent.wf.hordeFailed', { why }));
      }
      // Chat could not start for a reason a card answers: the add-on is gone, or a sign-in is needed.
      if (isStartBlock(result)) {
        if (alive.current) {
          if (result.blocked === 'signin') setSignInFor(choice.agentId);
          else void addons.refresh();
        }
      } else if (alive.current) {
        setSignInFor(null);
      }
    } catch (e) {
      if (alive.current) setError(errorSentence(e, t('newAgent.errStart')));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Tab' && !e.shiftKey && !prompt) {
      e.preventDefault();
      setPrompt(example);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const grow = (el: HTMLTextAreaElement) => growBox(el, 220);
  useEffect(() => {
    if (area.current) grow(area.current);
  }, [prompt]);

  // Files dragged in from Explorer become paths in the message, like the + menu's "Add files" (desktop app, this PC only).
  const canDrop = !remote && !place;
  useEffect(() => {
    if (!canDrop) return;
    return registerFileDrop({
      id: 'newagent-composer',
      getRect: () => menuRoot.current?.getBoundingClientRect() ?? null,
      onDrop: (paths) => setPrompt((text) => withPaths(text, paths)),
    });
  }, [canDrop]);

  const addFiles = async () => {
    setMenu(null);
    try {
      const paths = await api.pickPaths();
      if (paths.length > 0) setPrompt((text) => withPaths(text, paths));
    } catch {
      setError(t('newAgent.errFileDialog'));
    }
    area.current?.focus();
  };

  const chooseFolder = (project: ProjectChoice) => {
    setChosenFolder(project);
    setMenu(null);
    area.current?.focus();
  };
  /** A project from the list (or just added): it starts the agent and is remembered for next time. */
  const chooseProject = (p: ProjectChoice) => {
    if (!remote) writeLastProject(p);
    chooseFolder(p);
  };
  /** One-off folder (not saved, not remembered) or, with `save`, a new saved project. */
  const browseFolder = async (save = false) => {
    setError(null);
    try {
      const found = await api.pickFolder();
      if (!found || found.state === 'missing') return;
      const pick = { path: found.path, name: found.name, state: found.state };
      if (save) {
        saved.add(found.path);
        chooseProject(pick);
      } else chooseFolder(pick);
    } catch (e) {
      setError(errorSentence(e, t('newAgent.errFolderDialog')));
    }
  };
  // Folders agents run in now that are not saved projects yet (copies count as their project).
  const running = useMemo(() => {
    const out: ProjectChoice[] = [];
    for (const cwd of runningFolders) {
      const p = projectOfCwd(cwd);
      if (!p || saved.projects.some((x) => pathKey(x.path) === pathKey(p.path)) || out.some((x) => pathKey(x.path) === pathKey(p.path))) continue;
      out.push(p);
    }
    return out;
  }, [runningFolders, saved.projects]);

  // The project list of the picker: this PC's saved projects, or (another PC) the ones that PC knows.
  const menuProjects: { path: string; name?: string }[] = remote ? (recent ?? []).map((p) => ({ path: p.path, name: p.name })) : saved.projects;

  const setCards = (cards: HomeCard[]) => {
    setHome((h) => ({ ...h, cards }));
    api.saveCards(cards).catch(() => setError(t('newAgent.errCards')));
  };

  const cardData: CardData = {
    recent: recent ?? [],
    running: panes.filter((p) => p.status === 'running'),
    needs,
  };

  return (
    <section className="ck-na" aria-label={t('newAgent.title')}>
      <header className="ck-na-top">
        <span className="ck-na-top-title">{t('newAgent.title')}</span>
        {remote && (
          <span className="ck-na-top-on" data-testid="na-on-device">
            {t('newAgent.onDevice', { name: remote.deviceName })}
          </span>
        )}
      </header>
      <div className="ck-na-scroll">
        <div className="ck-na-center">
          <div className="ck-na-mark" aria-hidden="true">
            <IconSpark />
          </div>
          <h1 className="ck-na-ask" data-testid="na-ask">
            {t('newAgent.ask')}
          </h1>

          {fromTask && (
            <p className="ck-na-fromtask" role="note" data-testid="na-from-task">
              {t('teamHub.tasks.fromNote', { name: fromTask })}
            </p>
          )}
          {layers.wrap(
          <div className="ck-na-composer" ref={menuRoot}>
            <div className="ck-na-field">
              <textarea
                ref={area}
                className="ck-na-input"
                aria-label={t('newAgent.ask')}
                placeholder={example}
                rows={2}
                autoFocus
                value={prompt}
                disabled={busy}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  setPasteNote(null);
                }}
                onPaste={(e) => {
                  if (refusePaste(e)) setPasteNote(t('r12ui.paste.tooBig'));
                }}
                onKeyDown={onKey}
              />
              {pasteNote && (
                <p className="ck-na-note" role="alert" data-testid="na-paste-note">
                  {pasteNote}
                </p>
              )}
              {!prompt && (
                <span className="ck-na-tabhint" aria-hidden="true">
                  <kbd className="ck-chip-key">Tab</kbd> {t('newAgent.tabHint')} {/* i18n-ok: key name */}
                </span>
              )}
            </div>

            <div className="ck-na-row">
              {((!remote && !place) || (remote && copyOffered)) && (
              <Pop
                id="plus"
                open={menu === 'plus'}
                onToggle={() => setMenu(menu === 'plus' ? null : 'plus')}
                onClose={() => setMenu(null)}
                label={t('newAgent.addToMessage')}
                trigger={<IconPlus />}
                iconOnly
              >
                {!remote && (
                  <button type="button" role="menuitem" className="ck-na-item" onClick={() => void addFiles()}>
                    <span>{t('newAgent.addFiles')}</span>
                    <span className="ck-na-item-hint">{t('newAgent.addFilesHint')}</span>
                  </button>
                )}
                {copyOffered && (
                  <>
                    <div className="ck-na-toggle" title={t('newAgent.copyTip')}>
                      <span id="na-copy-label">{t('newAgent.copy')}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isolated}
                        aria-labelledby="na-copy-label"
                        className="ck-switch"
                        disabled={!canCopy}
                        onClick={() => {
                          setStoredCopy(!isolated);
                          writeCopyPreference(folderKey, !isolated);
                        }}
                      >
                        <span className="ck-switch-knob" />
                      </button>
                    </div>
                    {!canCopy ? (
                      <p className="ck-na-note">{runAs === 'chat' ? t('newAgent.copyMissing') : t('newAgent.needsGit')}</p>
                    ) : runAs === 'chat' && isPlainCopyFolder(folder?.state) ? (
                      <p className="ck-na-note">{t('newAgent.copyPlain')}</p>
                    ) : null}
                  </>
                )}
              </Pop>
              )}

              {leading}

              {workflows && !place && (
                <Pop
                  id="workflow"
                  open={menu === 'workflow'}
                  onToggle={() => setMenu(menu === 'workflow' ? null : 'workflow')}
                  onClose={() => setMenu(null)}
                  label={wf ? t('newAgent.wf.chip', { name: wf.plan.name }) : t('newAgent.wf.label')}
                  trigger={
                    <>
                      <span className="ck-na-chip-text">{wf ? t('newAgent.wf.chip', { name: wf.plan.name }) : t('newAgent.wf.label')}</span>
                      <IconChevronDown />
                    </>
                  }
                >
                  <button type="button" role="menuitemradio" aria-checked={!wf} className="ck-na-item" onClick={() => { setWfSlug(null); setMenu(null); area.current?.focus(); }}>
                    <span>{t('newAgent.wf.none')}</span>
                  </button>
                  {workflows.map((w) => (
                    <button key={w.slug} type="button" role="menuitemradio" aria-checked={wfSlug === w.slug} className="ck-na-item" onClick={() => { setWfSlug(w.slug); setMenu(null); area.current?.focus(); }}>
                      <span>{w.plan.name}</span>
                    </button>
                  ))}
                  {workflows.length === 0 && <p className="ck-na-note">{t(wfHidden > 0 ? 'newAgent.wf.needFixing' : 'newAgent.wf.empty')}</p>}
                </Pop>
              )}

              <Pop
                id="folder"
                open={menu === 'folder'}
                onToggle={() => {
                  setMenu(menu === 'folder' ? null : 'folder');
                  api.recent().then((list) => alive.current && setRecent(list)).catch(() => undefined);
                  if (menu !== 'folder') devices?.onOpen();
                }}
                onClose={() => setMenu(null)}
                label={t('newAgent.projectLabel', { name: folder?.name ?? t('newAgent.noneChosen') })}
                trigger={
                  <>
                    <IconFolder />
                    <span className="ck-na-chip-text">{folder?.name ?? t('newAgent.chooseProject')}</span>
                    <IconChevronDown />
                  </>
                }
              >
                {devices && devices.groups.length > 0 ? (
                  <DeviceProjectList
                    devices={devices}
                    folderPath={folder?.path ?? null}
                    local={dedupePaths(saved.projects.map((p) => ({ path: p.path, name: p.name?.trim() || folderName(p.path) })).concat(running.map((p) => ({ path: p.path, name: p.name }))))}
                    onPickLocal={(p) => (remote ? devices.onPickLocal(p) : chooseProject(p))}
                    onAddRemote={(node) => {
                      setMenu(null);
                      devices.onAddRemote(node);
                    }}
                    onPickRemote={(node, p) => (devices.currentNode === node ? chooseProject({ path: remotePathOf(p.id), name: p.name, state: gitStateOf(p.state) }) : devices.onPickRemote(node, p))}
                    onAddLocal={async (save) => {
                      if (!remote) return browseFolder(save);
                      // Another PC's page is showing: the system folder dialog is this PC's own.
                      try {
                        const found = await tauriNewAgentApi.pickFolder();
                        if (!found || found.state === 'missing') return;
                        if (save) saved.add(found.path);
                        devices.onPickLocal({ path: found.path, name: found.name, state: found.state });
                      } catch (e) {
                        setError(errorSentence(e, t('newAgent.errFolderDialog')));
                      }
                    }}
                  />
                ) : (
                  <>
                {menuProjects.length > 0 && <div className="ck-na-cap">{t('newAgent.projects')}</div>}
                {menuProjects.map((p) => (
                  <ProjectItem key={p.path} name={p.name?.trim() || folderName(p.path)} path={remote ? '' : p.path} inUse={folder?.path === p.path} onPick={() => chooseProject({ path: p.path, name: p.name?.trim() || folderName(p.path), ...(remote ? { state: (recent ?? []).find((r) => r.path === p.path)?.state } : {}) })} />
                ))}
                {running.length > 0 && <div className="ck-na-cap">{t('newAgent.runningNow')}</div>}
                {running.map((p) => (
                  <ProjectItem key={p.path} name={p.name} path={p.path} inUse={folder?.path === p.path} onPick={() => chooseProject(p)} />
                ))}
                {menuProjects.length === 0 && running.length === 0 && <p className="ck-na-note">{t('newAgent.noProjects')}</p>}
                {remote && <p className="ck-na-note" data-testid="na-only-opened">{t('newAgent.remote.onlyOpened', { name: remote.deviceName })}</p>}
                {!remote && (
                <div className="ck-na-foot">
                  <button type="button" role="menuitem" className="ck-na-item" onClick={() => void browseFolder(true)}>
                    <span>{t('newAgent.addProject')}</span>
                  </button>
                  <button type="button" role="menuitem" className="ck-na-item" onClick={() => void browseFolder(false)}>
                    <span>{t('newAgent.chooseOtherFolder')}</span>
                  </button>
                </div>
                )}
                  </>
                )}
              </Pop>

              {wf ? (
                <button type="button" className="ck-na-chip is-locked" disabled data-testid="na-agent-locked" title={t('newAgent.wf.locked')} aria-label={t('newAgent.agentLabel', { name: choice?.label ?? wf.plan.front_agent })}>
                  <AgentLogo id={wf.plan.front_agent} name={choice?.label ?? wf.plan.front_agent} size={13} decorative className="ck-na-logo" />
                  <span className="ck-na-chip-text">{choice?.label ?? wf.plan.front_agent}</span>
                </button>
              ) : (
              <Pop
                id="agent"
                open={menu === 'agent'}
                onToggle={() => setMenu(menu === 'agent' ? null : 'agent')}
                onClose={() => setMenu(null)}
                label={t('newAgent.agentLabel', { name: choice?.label ?? t('newAgent.agentNone') })}
                trigger={
                  <>
                    <span className={`ck-na-dot is-${choice?.state ?? 'missing'}`} aria-hidden="true" />
                    {choice && <AgentLogo id={choice.agentId} name={choice.label} size={13} decorative className="ck-na-logo" />}
                    <span className="ck-na-chip-text">{choice?.label ?? t('newAgent.noAgentReady')}</span>
                    <IconChevronDown />
                  </>
                }
              >
                {plainChoices.map((c) => renderChoice(c))}
                {myChoices.length > 0 && (
                  <div role="group" aria-label={t('myAgents.title')} data-testid="na-my-agents">
                    <div className="ck-na-note" data-testid="na-my-agents-head">
                      {t('myAgents.title')}
                    </div>
                    {myChoices.map((c) => renderChoice(c, true))}
                    <div className="ck-na-note">{t('myAgents.note', { name: remote?.deviceName ?? '' })}</div>
                  </div>
                )}
                <NeedTerminalsLine count={needTerminals} className="ck-na-note" onOpen={() => setMenu(null)} />
                {onSetUp && (
                  <button
                    type="button"
                    role="menuitem"
                    className="ck-na-item"
                    onClick={() => {
                      setMenu(null);
                      onSetUp();
                    }}
                  >
                    <span>{t('newAgent.setUpAgents')}</span>
                  </button>
                )}
              </Pop>
              )}

              {chatLane && !chatFirst && (
                <div className="ck-na-seg" role="radiogroup" aria-label={t('newAgent.runAs')}>
                  {(['terminal', 'chat'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={runAs === mode}
                      disabled={mode === 'chat' && lendNoChat}
                      title={mode === 'chat' && lendNoChat ? t('newAgent.lentNoChatTerminal') : undefined}
                      className="ck-na-seg-btn"
                      onClick={() => {
                        setRunPick(mode);
                        if (!remote) rememberRunAs(mode);
                      }}
                    >
                      {mode === 'terminal' ? t('newAgent.terminal') : t('newAgent.chat')}
                    </button>
                  ))}
                </div>
              )}

              {wf && (
                <button type="button" className="ck-na-chip is-locked" disabled data-testid="na-model-locked" title={t('newAgent.wf.locked')}>
                  <span className="ck-na-chip-text">{wf.plan.front_model ? prettyModel(wf.plan.front_model) : t('models.agentDefault')}</span>
                </button>
              )}
              {!wf && showModel && choice && (
                <ModelPicker
                  testId="na-model"
                  label={t('newAgent.modelFor', { name: choice.label })}
                  state={modelList}
                  value={model}
                  onChange={(next) => {
                    setModelPick({ slot: modelSlot, value: next });
                    if (!remote) writePickedModel(choice.agentId, choice.accountId, next);
                  }}
                />
              )}

              <span className="ck-na-spacer" />
              {remote?.agentsOff ? (
                // Where Start was: the real Ask button (a card is raised on the far PC; nothing is granted by asking). The sentence is under the box.
                remote.agentsOff.ask && remote.agentsOff.ask.state !== 'asked' ? (
                  <button type="button" className="ck-na-send ck-na-ask-btn" data-testid="na-agents-ask" disabled={remote.agentsOff.ask.state === 'asking'} onClick={remote.agentsOff.ask.onAsk}>
                    {remote.agentsOff.ask.state === 'asking' ? remote.agentsOff.ask.askingLabel : remote.agentsOff.ask.label}
                  </button>
                ) : null
              ) : (
                <button type="button" className="ck-na-send" aria-label={t('newAgent.start')} title={block ?? t('newAgent.startTip')} disabled={block !== null} onClick={() => void send()}>
                  {t('newAgent.start')}
                </button>
              )}
            </div>
          </div>
          )}

          {wf && (
            <p className="ck-na-wf" data-testid="na-wf-summary">
              <span>
                {workflowSummary(wf.plan, { agent: (id) => agents.find((a) => a.id === id)?.label ?? id, model: (_agent, m) => prettyModel(m) })}{' '}
                {wf.plan.start_mode === 'horde' ? `${t('newAgent.wf.horde')} ` : ''}
                {t(wf.plan.reply_style === 'router' ? 'newAgent.wf.reply.router' : 'newAgent.wf.reply.translator')}
              </span>{' '}
              <button type="button" className="ck-na-link" onClick={() => openSettingsAt('crews')}>
                {t('newAgent.wf.edit')}
              </button>
            </p>
          )}

          <PinnedLine pins={pins} />

          {signInCard && choice ? (
            <div className="ck-na-card">
              <SignInCard
                label={addon?.label ?? choice.label}
                hint={addon?.signin_hint ?? ''}
                onOpen={async () => {
                  // The page is replaced by the terminal: keep what was typed for the trip back.
                  saveTrip({ pickKey: choice.key, prompt, folder: folder ? { path: folder.path, name: folder.name } : undefined });
                  await onSignIn?.(choice.agentId, folder?.path);
                }}
                onRetry={async () => {
                  setSignInFor(null);
                  await send();
                }}
              />
            </div>
          ) : (
            installFirst &&
            addon && (
              <div className="ck-na-card">
                <AddonPrompt status={addon} onInstall={() => void addons.install(addon.agent)} />
              </div>
            )
          )}

          <p className="ck-na-hint" role={error ? 'alert' : undefined}>
            {error ?? <DisabledReason as="span" reason={remote?.agentsOff ? null : (block ?? (lendNoChat && chatLane && !chatFirst ? t('newAgent.lentNoChatTerminal') : null))} />}
          </p>

          {remote && (
            <div className="ck-na-off" data-testid="na-remote-lines">
              {remote.agentsOff && (
                <span className="ck-na-ask-line" data-testid="na-agents-off">
                  <span className="ck-na-ask-line-main">{remote.agentsOff.line}</span>
                  {remote.agentsOff.ask?.state === 'asked' && (
                    <span className="ck-na-ask-line" role="status" data-testid="na-agents-ask-waiting">
                      {remote.agentsOff.ask.askedLine}
                    </span>
                  )}
                </span>
              )}
              {remote.agentsOff?.ask?.error ? (
                <span className="ck-na-ask-line" role="alert" data-testid="na-agents-ask-error">
                  {remote.agentsOff.ask.error}
                </span>
              ) : null}
              <span className="ck-na-ask-line" data-testid="na-runs-on">
                {choice?.accountId === LEND_MINE
                  ? t('myAgents.runsOn', { name: remote.deviceName, agent: choice.agentLabel ?? choice.label, pc: remote.mine?.thisName ?? '' })
                  : farPlan?.signedOut && farPlan.lend
                    ? t('newAgent.remote.runsOnLend', { name: remote.deviceName, borrowed: farPlan.lend.name })
                    : farNoSignIn
                      ? t('newAgent.remote.notSignedInHelp', { name: remote.deviceName, agent: choice?.agentLabel ?? choice?.label ?? '' }) + (remote.mine?.agents.some((a) => a.agentId === choice?.agentId) ? ' ' + t('newAgent.remote.orLendYours', { account: t('myAgents.account', { name: remote.mine.thisName }) }) : '')
                      : t('newAgent.remote.runsOn', { name: remote.deviceName, agent: choice?.label ?? '' })}
              </span>
            </div>
          )}

          {!prompt && (
            <Starters
              remote={!!remote}
              onUse={(text) => {
                setPrompt(text);
                area.current?.focus();
              }}
              onPin={!remote && canAdd(home.cards, 'prompt') ? (text) => setCards(addCard(home.cards, 'prompt', text)) : undefined}
            />
          )}
          {continueYesterday && (
            <ContinueCard
              {...continueYesterday}
              onFresh={(text) => {
                setPrompt(text);
                area.current?.focus();
              }}
            />
          )}
          {!remote && <GettingStarted onStartAgent={() => area.current?.focus()} agentCount={panes.length} />}
          {!remote && <HomeCards
            cards={home.cards}
            data={cardData}
            onChange={setCards}
            onUseFolder={(p) => chooseFolder({ path: p.path, name: p.name, state: p.state })}
            onOpenPane={onOpenPane}
            onUsePrompt={(text) => {
              setPrompt(text);
              area.current?.focus();
            }}
          />}
        </div>
      </div>
    </section>
  );
}

/** A chip that opens a small menu under it. */
const LS_LAST_PROJECT = 'pm.newagent.lastProject';

/** The project the last agent was started in from the page's picker. Broken storage reads as none. */
function readLastProject(): ProjectChoice | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LS_LAST_PROJECT) ?? 'null');
    const { path, name } = (v ?? {}) as { path?: unknown; name?: unknown };
    return typeof path === 'string' && path !== '' ? { path, name: typeof name === 'string' && name ? name : folderName(path) } : null;
  } catch {
    return null;
  }
}
function writeLastProject(p: ProjectChoice): void {
  try {
    localStorage.setItem(LS_LAST_PROJECT, JSON.stringify({ path: p.path, name: p.name }));
  } catch {
    /* a convenience only */
  }
}

function ProjectItem({ name, path, inUse, onPick }: { name: string; path: string; inUse: boolean; onPick: () => void }) {
  const t = useT();
  return (
    <button type="button" role="menuitem" className="ck-na-item" title={path} onClick={onPick}>
      <span className="ck-na-item-main">
        <span>{name}</span>
        <span className="ck-na-item-path">{shortPath(path)}</span>
      </span>
      {inUse && <span className="ck-na-item-hint">{t('newAgent.inUse')}</span>}
    </button>
  );
}

/** The last two folders of a path, so a long one stays on one line. */
const shortPath = (path: string): string => {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : path;
};

function Pop({
  id,
  open,
  onToggle,
  onClose,
  label,
  trigger,
  iconOnly = false,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  /** Closes the menu (an outside press, Escape). Separate from `onToggle`, which flips it. */
  onClose: () => void;
  label: string;
  trigger: ReactNode;
  iconOnly?: boolean;
  children: ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="ck-na-pop">
      <button
        ref={btn}
        type="button"
        className={`ck-na-chip${iconOnly ? ' ck-na-chip--icon' : ''}`}
        data-testid={`na-${id}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {trigger}
      </button>
      {open && (
        <SharedMenu anchorRef={btn} align="start" className="ck-na-menu" label={label} onClose={onClose}>
          {children}
        </SharedMenu>
      )}
    </div>
  );
}

/** The same folder listed twice (a saved project that is also running) is listed once. */
function dedupePaths<T extends { path: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = pathKey(p.path);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The grouped project list: "<this PC> (this PC)" with its folders, then each other PC under its own name. Every group ends with its
 * own "Add project". A PC that cannot be used is greyed with the reason in words, and is not asked for anything.
 */
function DeviceProjectList({
  devices,
  local,
  folderPath,
  onPickLocal,
  onPickRemote,
  onAddRemote,
  onAddLocal,
}: {
  devices: DevicePicker;
  local: { path: string; name: string }[];
  folderPath: string | null;
  onPickLocal: (p: ProjectChoice) => void;
  onPickRemote: (node: string, p: { id: string; name: string; state: string }) => void;
  onAddRemote: (node: string) => void;
  /** The system folder dialog of this PC: `save` adds a project ("Add project"), otherwise it is a one-off folder ("Choose other folder"). */
  onAddLocal: (save: boolean) => void | Promise<void>;
}) {
  const t = useT();
  return (
    <div className="ck-na-groups" data-testid="na-groups">
      <div className="ck-na-group" data-testid="na-group-this">
        <div className="ck-na-cap">{t('newAgent.dev.thisPc', { name: devices.thisName })}</div>
        {local.length === 0 && <p className="ck-na-note">{t('newAgent.noProjects')}</p>}
        {local.map((p) => (
          <ProjectItem key={p.path} name={p.name} path={p.path} inUse={devices.currentNode === null && folderPath === p.path} onPick={() => onPickLocal(p)} />
        ))}
        <div className="ck-na-foot">
          <button type="button" role="menuitem" className="ck-na-item" data-testid="na-add-this" onClick={() => void onAddLocal(true)}>
            <span>{t('newAgent.addProject')}</span>
          </button>
          <button type="button" role="menuitem" className="ck-na-item" data-testid="na-other-this" onClick={() => void onAddLocal(false)}>
            <span>{t('newAgent.chooseOtherFolder')}</span>
          </button>
        </div>
      </div>
      {devices.groups.map((g) => (
        <div key={g.node} className={`ck-na-group${g.state === 'away' ? ' is-away' : ''}`} data-testid={`na-group-${g.node}`}>
          <div className="ck-na-cap">{g.name}</div>
          {g.state === 'away' ? (
            <p className="ck-na-note" data-testid={`na-group-away-${g.node}`}>
              {g.status === 'offline' ? t('newAgent.dev.offline', { name: g.name }) : t('newAgent.dev.cant', { name: g.name, why: g.why ?? '' })}
            </p>
          ) : (
            <>
              {g.state === 'loading' && <p className="ck-na-note">{t('newAgent.dev.loading', { name: g.name })}</p>}
              {g.state === 'failed' && <p className="ck-na-note" data-testid={`na-group-failed-${g.node}`}>{t('newAgent.dev.failed', { name: g.name })}</p>}
              {g.state === 'ready' && g.projects.length === 0 && <p className="ck-na-note">{t('newAgent.dev.none', { name: g.name })}</p>}
              {g.projects.map((p) => (
                <ProjectItem key={p.id} name={p.name} path="" inUse={devices.currentNode === g.node && folderPath === remotePathOf(p.id)} onPick={() => onPickRemote(g.node, p)} />
              ))}
              <div className="ck-na-foot">
                <button type="button" role="menuitem" className="ck-na-item" data-testid={`na-add-${g.node}`} onClick={() => onAddRemote(g.node)}>
                  <span>{t('newAgent.addProject')}</span>
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
