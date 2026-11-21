import { guideMock } from './guide-fixtures';
// Mocks the Tauri IPC layer so the real UI runs in a plain browser.
import { standbyHelpersView } from './standby-helpers-fixtures';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { HarnessScenario } from './types';
import { FIXTURE_TURN_FILES, SAMPLE_PATCH, sampleDay, sampleNowDiff } from './timeline-fixtures';
import type { DeskAway, DeskLength } from '../lib/desk-away-types';
import { EXAMPLE_FILE_PATCH, EXAMPLE_TURN_REVIEW } from './desk-review-fixtures';
import {
  EXAMPLE_CHECKPOINTS,
  EXAMPLE_DIGEST,
  EXAMPLE_TURN_SUMMARIES,
  EXAMPLE_FILE_CHANGES,
  EXAMPLE_PANES,
  EXAMPLE_PROMPT,
  HIGH_RISK_PROMPT,
  PANE_CODEX,
  EXAMPLE_RUN,
  EXAMPLE_WORKTREE,
  EXAMPLE_WORKTREE_DIFF,
  EXAMPLE_TRANSCRIPT,
  PANE_CLAUDE,
  SCREEN_REPLAY,
  ACCOUNT_AGENTS,
  agentsListing,
  TOOLBELT_IMPORT,
  AGENT_PACK_INSPECTION,
  AGENT_PACK_PREVIEW,
  TOOLBELT_LISTING,
  TOOLBELT_PREVIEW,
  standbyStatus,
  EXAMPLE_REVIEWERS,
  EXAMPLE_REVIEW_START,
  EXAMPLE_REVIEW_POLL,
} from './fixtures';
import { TEAM_DIFF, teamConfig } from './team-fixtures';
import { borrowedOf, createLendMock } from './lend-fixtures';
import { previewFor } from './shelf-fixtures';
import { createAccountMock } from './account-pcs-fixtures';
import { createDevicesMock } from './devices-fixtures';
import { shipMock } from './ship-fixtures';
import { sidebarBranch, sidebarWorktree } from './fixtures-sidebar';
import { simpleMock } from './simple-fixtures';
import { firstRunMock, firstRunStore } from './first-run-fixtures';
import { missionMock } from './mission-fixtures';
import { keepGoingMock } from './keep-going-fixtures';
import { projectBudgetMock } from './project-budget-fixtures';
import { branchMock } from './branch-fixtures';
import { FAKE_UNINSTALL_PLAN, runFakeUninstall } from './uninstall-fixtures';
import { nightMock } from './night-fixtures';
import { routinesMock } from './routines-fixtures';
import { packageCheckMock } from './package-check-fixtures';
import { reviewDeskMock } from './review-desk-fixtures';
import { wslMock } from './wsl-fixtures';
import { sshMock } from './ssh-fixtures';
import { closedChatsMock } from './closed-chats-fixtures';
import { bringChatsMock, newBringChatsState } from './bring-chats-fixtures';
import type { ClosedChat } from '../lib/closedChats';
import { whatBrokeItMock } from './what-broke-it-fixtures';
import { whatBrokeItResultMock } from './what-broke-it-result-fixtures';
import { collisionMock } from './collision-fixtures';
import { filesMock } from './files-fixtures';
import { artifactsMock } from './artifacts-fixtures';
import { addAgentMock } from './add-agent-fixtures';
import { agentCapsMock } from './agent-caps-fixtures';
import { createLocalAcpChatMock, localAcpPane } from './local-acp-chat-mock';

const DOCTOR_ROWS = [
  { id: 'claude', label: 'Claude', state: 'unchecked', installed: true, version: '2.1.4 (Claude Code)', reason: 'Installed. Press Test to check it can answer.', install_hint: 'winget install Anthropic.ClaudeCode', install_fallback: 'npm i -g @anthropic-ai/claude-code', login_hint: 'Open Claude and type /login', can_test: true, hooks: { state: 'connected', mode: 'shadow', sentence: 'Connected. Claude tells Potato Workspace when it starts, asks and finishes. Watch only: Potato Workspace still decides from the screen.' } },
  { id: 'codex', label: 'Codex', state: 'needs_login', installed: true, version: 'codex-cli 0.162.1', reason: 'It needs you to sign in first.', install_hint: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', install_fallback: 'npm i -g @openai/codex', login_hint: 'Run: codex login', can_test: true, hooks: { state: 'off', mode: 'off', sentence: 'Live updates are off.', opt_in: true, opt_in_note: 'Potato Workspace adds a small file to .codex in each project; Codex asks you to review it once per folder.', enabled: false } },
  { id: 'opencode', label: 'OpenCode', state: 'not_installed', installed: false, version: null, reason: 'Not installed on this computer.', install_hint: 'winget install SST.opencode', login_hint: 'Open OpenCode and type /connect', can_test: false },
  { id: 'cursor_agent', label: 'Cursor Agent', state: 'error', installed: true, version: null, reason: 'Found it, but it did not start properly: exit code 1', install_hint: null, login_hint: 'Run: agent login', can_test: true, hooks: { state: 'not_supported', mode: 'shadow', sentence: "This agent can't report to Potato Workspace directly. Potato Workspace reads its screen." } },
];

/** The notification choices the mock PC keeps (a real PC keeps them on disk). */
const NOTIFY_PREFS = { bells: {} as Record<string, string>, quiet: { enabled: false, start: 1320, end: 420 }, snoozes: {} as Record<string, number>, imported: true };

const EXAMPLE_BODY = {
  mood: 'genki',
  intensity: 2,
  energy: 78,
  hunger: 35,
  boredom: 52,
  longing: 20,
  battery: 88,
  drives: [
    { name: 'Say hello', value: 7, max: 10, threshold: 8, waiting: true },
    { name: 'Tidy notes', value: 3, max: 10, threshold: 8, waiting: false },
    { name: 'Look around', value: 5, max: 10, threshold: 7, waiting: false },
  ],
  awayMinutes: 125,
  sleeping: false,
};
const EXAMPLE_JOURNAL = {
  days: [
    { date: '2026-11-15', lines: ['Ren came back after a nap.', 'We fixed the sign-in page.', 'I wrote down that Ren likes short answers.'] },
    { date: '2026-11-14', lines: ['A quiet day. I watched two agents finish.'] },
  ],
  diary: { date: '2026-11-15', text: 'Today Ren came back after a long nap. We looked at the sign-in page together. It was slow, but it got done. I think tomorrow will be easier. I also met Mei, who asked about the build.' },
  people: [{ name: 'Ren', closeness: 3 }, { name: 'Mei', closeness: 1 }],
  personaFiles: ['SOUL.md'],
};

const WORKFLOW_PLAN = {
  name: 'Haiku router',
  front_name: 'Front',
  front_agent: 'claude',
  front_model: 'haiku',
  helpers: [
    { name: 'Hard', agent_type: 'claude', model: 'sonnet', when_to_use: 'hard tasks', kind: 'minion' },
    { name: 'Easy', agent_type: 'claude', model: 'opencode-go/deepseek-v4.1-flash', when_to_use: 'easy tasks', kind: 'minion' },
  ],
  start_mode: 'front',
  helper_cap: 3,
  reply_style: 'translator',
  brief: '',
  first_message: '',
};
const WORKFLOW_CREW = {
  name: 'Haiku router',
  how_i_work: 'Keep answers short. Say which helper did the work.',
  roles: [
    { name: 'Front', agent_type: 'claude', model: 'haiku', task: 'Answer short questions yourself. Send the rest to the right helper.', front: true },
    { name: 'Hard', agent_type: 'claude', model: 'sonnet', task: 'Do the hard coding tasks.', parent: 'Front', when_to_use: 'hard coding tasks' },
    { name: 'Easy', agent_type: 'claude', model: 'haiku', task: 'Do the easy tasks.', parent: 'Front', when_to_use: 'easy tasks', kind: 'spin_off' },
  ],
};

export function installTauriMock(scenario: HarnessScenario): void {
  const lendMock = createLendMock(scenario.lend);
  const devicesMock = createDevicesMock(scenario.devices);
  const accountMock = createAccountMock(scenario.account);
  const closedState: { chats: ClosedChat[] | null } = { chats: null };
  const bringState = newBringChatsState();
  const localAcp = createLocalAcpChatMock(scenario.localAcpChat);
  const panes = [...(scenario.panes ?? EXAMPLE_PANES), ...(scenario.localAcpChat ? [localAcpPane(scenario.localAcpChat)] : [])];
  // In-memory plugin-store (one store, rid 1), keyed as the app writes it.
  // The two agent-authority switches, at the shipped defaults unless the scenario says otherwise.
  let authority = scenario.authority ?? { ask_before_agent_control: true, agents_may_merge: false, ask_before_helpers_start: false };
  const store = new Map<string, unknown>([['settings', { theme: scenario.theme ?? 'dark', ...(scenario.simple ? { simple_mode: true } : {}), ...firstRunStore(scenario.firstRun), ...(scenario.missions?.enabled ? { missions_enabled: true } : {}), ...(scenario.lend ? { lend_enabled: true } : {}), ...(scenario.markup ? { markup_bar_enabled: true } : {}), ...(scenario.timeline ? { timeline_day_enabled: true } : {}), ...(scenario.workflows ? { workflows_enabled: true, crews_enabled: true } : {}), ...(scenario.devices && scenario.devices.enabled !== false ? { devices_enabled: true } : {}), ...(scenario.account ? { account_enabled: true } : {}), show_terminals: !scenario.chatFirst }]]);
  // Settings > Phone > Devices: one phone with full control in daily use, one watch-and-answer.
  const now = Math.floor(Date.now() / 1000);
  const day = 24 * 60 * 60;
  const paneRemote: Record<string, { remote: boolean; level: string }> = {};
  // "Leaving my desk": one paired phone, the switch off unless the scenario says otherwise.
  let desk: DeskAway = scenario.desk ?? { away: false, lock_screen: false, phones: 1 };
  let pairedDevices = [
    { id: '6f1c2a90-aaaa-4bbb-8ccc-000000000001', name: "Maya's iPhone", public_key: 'pk1', paired_at: now - 40 * day, caps: ['watch', 'answer', 'type', 'control'], expires_at: now + 30 * day - 600, last_seen: now - 600, expired: false, idle_expiry_secs: 30 * day },
    { id: '6f1c2a90-aaaa-4bbb-8ccc-000000000002', name: 'Pixel 8', public_key: 'pk2', paired_at: now - 9 * day, caps: ['watch', 'answer'], expires_at: now + 21 * day, last_seen: now - 9 * day, expired: false, idle_expiry_secs: 30 * day },
    { id: '6f1c2a90-aaaa-4bbb-8ccc-000000000003', name: 'Old iPad', public_key: 'pk3', paired_at: now - 120 * day, caps: ['watch', 'answer', 'type', 'control'], expires_at: now - 2 * day, last_seen: now - 32 * day, expired: true, idle_expiry_secs: 30 * day },
  ];
  if (scenario.phones === 'none') pairedDevices = [];
  if (scenario.phones === 'basic') pairedDevices = pairedDevices.slice(0, 1).map((d) => ({ ...d, caps: ['watch', 'answer', 'type'] }));

  mockWindows(scenario.route === 'settings' ? 'settings' : scenario.route === 'askbar' ? 'askbar' : 'cockpit');
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const welcome = firstRunMock(scenario.firstRun, cmd, a);
      if (welcome.handled) return welcome.value;
      const simple = simpleMock(scenario.simple, cmd, a);
      if (simple.handled) return simple.value;
      const shipped = shipMock(scenario.ship, cmd, a);
      if (shipped.handled) return shipped.value;
      const mission = missionMock(scenario.missions, cmd, a);
      if (mission.handled) return mission.value;
      const projectBudget = projectBudgetMock(scenario.projectBudget, cmd);
      if (projectBudget.handled) return projectBudget.value;
      const keepGoing = keepGoingMock(scenario.keepGoing, cmd, a);
      if (keepGoing.handled) return keepGoing.value;
      const branch = branchMock(scenario.branch, cmd, a);
      if (branch.handled) return branch.value;
      const addAgent = addAgentMock(scenario.addAgent, cmd, a);
      if (addAgent.handled) return addAgent.value;
      const agentCaps = agentCapsMock(cmd, a);
      if (agentCaps.handled) return agentCaps.value;
      const files = filesMock(cmd, a);
      if (files.handled) return files.value;
      const artifacts = artifactsMock(cmd, a);
      if (artifacts.handled) return artifacts.value;
      const collision = collisionMock(scenario.collision, cmd, a);
      if (collision.handled) return collision.value;
      const night = nightMock(scenario.night, cmd, a);
      if (night.handled) return night.value;
      const routines = routinesMock(scenario.routines, cmd);
      if (routines.handled) return routines.value;
      const packageCheck = packageCheckMock(scenario.packageCheck, cmd, a);
      if (packageCheck.handled) return packageCheck.value;
      const reviewDesk = reviewDeskMock(scenario.reviewDesk, cmd, a);
      if (reviewDesk.handled) return reviewDesk.value;
      const guide = guideMock(scenario.guide, cmd);
      if (guide.handled) return guide.value;
      const lend = lendMock(cmd, a);
      if (lend.handled) return lend.value;
      const account = accountMock(cmd, a);
      if (account.handled) return account.value;
      const devices = devicesMock(cmd, a);
      if (devices.handled) return devices.value;
      const closed = closedChatsMock(scenario.closedChats, closedState, cmd, a);
      if (closed.handled) return closed.value;
      const bringChats = bringChatsMock(scenario.bringChats, bringState, cmd, a);
      if (bringChats.handled) return bringChats.value;
      const wsl = wslMock(scenario.wsl, cmd, a);
      if (wsl.handled) return wsl.value;
      const ssh = sshMock(scenario.ssh, cmd, a);
      if (ssh.handled) return ssh.value;
      const whatBroke = whatBrokeItMock(scenario.whatBroke, cmd, a);
      if (whatBroke.handled) return whatBroke.value;
      const localChat = localAcp(cmd, a); if (localChat.handled) return localChat.value;
      const wbResult = whatBrokeItResultMock(scenario.whatBrokeItResult, cmd, a); if (wbResult.handled) return wbResult.value;
      switch (cmd) {
        // No phone has asked for control in the preview (a null answer crashed the control-ask notice).
        case 'list_control_asks':
          return [];
        case 'list_panes':
          return panes;
        case 'accounts_set_helper_login':
          return a.value;
        case 'accounts_list':
          return { agents: ACCOUNT_AGENTS, accounts: scenario.accounts ?? [], borrowed: borrowedOf(scenario.lend?.grants ?? []) };
        case 'new_pane':
          return 'pane-new-1';
        case 'pane_prompt':
          return a.paneId === PANE_CLAUDE ? EXAMPLE_PROMPT : a.paneId === PANE_CODEX ? HIGH_RISK_PROMPT : null;
        case 'get_ui_mode':
          return 'orchestration';
        case 'standby_set_current_project':
          return false;
        case 'standby_helpers_get':
          return standbyHelpersView;
        case 'standby_get_status':
          return standbyStatus(scenario.standbyIdleSecs, scenario.standbyBlocked);
        case 'workflows_list':
          return scenario.workflows ? [{ slug: 'haiku-router', plan: WORKFLOW_PLAN }] : null;
        case 'workflows_plan':
          return { ...WORKFLOW_PLAN, brief: 'You are the front of the workflow.', first_message: 'You are the front of the workflow.' };
        case 'crews_list':
          return scenario.workflows ? [{ slug: 'haiku-router', name: 'Haiku router', roles: 3, agents: ['claude'], problem: null }] : [];
        case 'crews_templates':
        case 'crews_starters':
          return [];
        case 'crews_agents':
          return { agents: [{ id: 'claude', label: 'Claude' }], default: 'claude' };
        case 'crews_check':
          return [];
        case 'crews_get':
          return WORKFLOW_CREW;
        case 'crews_open':
          return { slug: 'haiku-router', kind: 'saved', crew: WORKFLOW_CREW, routing_text: '', problems: [] };
        case 'agents_list':
          return agentsListing(scenario.headlessOnlyAgent);
        case 'pane_run_info':
          return scenario.runs?.[String(a.paneId)] ?? (a.paneId === PANE_CLAUDE ? EXAMPLE_RUN : null);
        case 'budget_for_pane':
          return scenario.budgets?.[String(a.paneId)] ?? null;
        case 'budget_adjust':
          return a.action === 'stop' ? 'Stopped at its budget.' : a.action === 'add_minutes' ? 'Added 30 min.' : 'Added 10 turns.';
        case 'pane_worktree':
          return a.paneId === PANE_CLAUDE ? EXAMPLE_WORKTREE : sidebarWorktree(String(a.paneId));
        case 'pane_git_branch':
          return sidebarBranch(String(a.paneId));
        case 'second_opinion_agents':
          return EXAMPLE_REVIEWERS;
        case 'second_opinion_start':
          return EXAMPLE_REVIEW_START;
        case 'second_opinion_poll':
          return EXAMPLE_REVIEW_POLL;
        case 'second_opinion_cancel':
          return null;
        case 'second_opinion_send':
          return { route: 'run', target: 'refactor-auth' };
        case 'worktree_diff':
          return EXAMPLE_WORKTREE_DIFF;
        case 'pane_transcript':
          return a.paneId === PANE_CLAUDE ? EXAMPLE_TRANSCRIPT : null;
        case 'checkpoints_list':
          if (scenario.checkpointsState === 'too_big') {
            return { state: 'too_big', message: 'Undo is off for this folder: it is too big. Add big folders to .gitignore.', items: [] };
          }
          return a.paneId === PANE_CLAUDE ? EXAMPLE_CHECKPOINTS : { state: 'ok', message: '', items: [] };
        case 'checkpoint_diff':
          return EXAMPLE_FILE_CHANGES;
        case 'timeline_day': {
          const day = sampleDay();
          const asked = String(a.date ?? day.date);
          const empty = typeof scenario.timeline === 'object' && scenario.timeline.empty;
          return { ...day, lanes: empty ? [] : day.lanes, date: asked, today: asked, dates: [asked] };
        }
        case 'timeline_point_diff':
          return FIXTURE_TURN_FILES;
        case 'timeline_now_diff': {
          const refused = typeof scenario.timeline === 'object' ? scenario.timeline.refused : undefined;
          if (refused) throw refused;
          return sampleNowDiff();
        }
        case 'timeline_file_patch':
          return [SAMPLE_PATCH, false];
        case 'timeline_go_back':
          return { safetyId: '9', written: 4, removed: 1, failed: [] };
        case 'checkpoint_restore':
        case 'checkpoint_undo_last':
          return { safetyId: '7', written: 4, removed: 1, failed: [] };
        case 'checkpoint_turn_review':
          return a.paneId === PANE_CLAUDE ? EXAMPLE_TURN_REVIEW : null;
        case 'checkpoint_file_patch':
          return EXAMPLE_FILE_PATCH;
        case 'checkpoint_put_back':
          return { safetyId: '9', action: 'written' };
        case 'editors_found':
          return [{ id: 'vscode', name: 'VS Code' }];
        case 'open_in_editor':
          return null;
        case 'turn_summaries':
          return scenario.turnSummaries?.[a.paneId as string] ?? (a.paneId === PANE_CLAUDE ? EXAMPLE_TURN_SUMMARIES : []);
        case 'companion_agents':
          return [
            { id: 'claude', label: 'Claude', ok: true, reason: null },
            { id: 'codex', label: 'Codex', ok: true, reason: null },
          ];
        case 'companion_list':
          if (scenario.companion && scenario.moreCompanions) {
            const base = { persona: 'calm', agentType: 'claude', agentLabel: 'Claude', folderName: 'home', stateLine: '', paneId: null, needs: null, pendingMemory: 0, nextCheckin: null, restarts: 0, autoStart: true };
            return [
              { ...base, id: 'mochi', name: 'Mochi', avatar: 'mochi', accent: 'potato', isDefault: true, state: scenario.companion, pendingMemory: 2 },
              { ...base, id: 'bit', name: 'Bit', avatar: 'bit', accent: 'sky', isDefault: false, state: 'sleeping' },
              { ...base, id: 'nib', name: 'Nib', avatar: 'nib', accent: 'mint', isDefault: false, state: 'sleeping' },
            ];
          }
          return scenario.companion
            ? [{ id: 'mochi', name: 'Mochi', avatar: 'mochi', persona: 'calm', agentType: 'claude', agentLabel: 'Claude', folderName: 'home', state: scenario.companion, stateLine: '', paneId: null, needs: null, pendingMemory: 2, nextCheckin: null, restarts: 0, autoStart: true, ...(scenario.companionBody ? { body: EXAMPLE_BODY } : {}) }]
            : [];
        case 'companion_journal':
          return EXAMPLE_JOURNAL;
        case 'discord_bot_status':
        case 'discord_bot_set_token':
        case 'discord_bot_clear':
        case 'discord_bot_save_settings':
          return {
            enabled: !!scenario.companionDiscord,
            storeAvailable: true,
            set: true,
            last4: 'ab12',
            botName: 'Mochi Bot',
            state: 'online',
            callsToday: 4,
            callsCap: 50,
            settings: {
              on: true,
              allow: [{ guildId: '111111111111111111', channels: ['222222222222222222', '333333333333333333'], ambient: false }],
              owners: ['444444444444444444'],
              dms: 'owners',
              names: ['Mochi'],
              gate: 'heuristic',
              budget: { count: 3, minutes: 60 },
            },
          };
        case 'discord_bot_test':
          return { ok: true, message: 'The token is saved and looks right.' };
        case 'side_question_target':
          return { agent: 'claude', label: 'Claude' };
        case 'side_question_ask':
          return { ok: true, answer: 'It is fixing the sign-in page and running the tests.' + String.fromCharCode(10) + 'It needs a yes or no from you before it changes the database.' };
        case 'away_digest_pending':
          return scenario.awayDigest ? EXAMPLE_DIGEST : null;
        case 'away_digest_dismiss':
        case 'presence_cockpit_focus':
          return null;
        case 'read_pane_screen_replay':
          return SCREEN_REPLAY;
        case 'read_pane_raw_buffer':
          return SCREEN_REPLAY.data;
        case 'read_pane_buffer':
        case 'read_pane_snapshot':
          return '';
        case 'get_project_path_cmd':
          return 'C:\\Users\\dev\\work\\potato-workspace';
        case 'pane_activities':
          return Object.fromEntries(
            panes.map((p) => [
              p.id,
              p.status === 'waiting_input'
                ? { kind: 'waiting', text: 'Needs you · Run tests' }
                : p.status === 'running'
                  ? { kind: 'working', text: 'Editing src/app.ts' }
                  : { kind: 'idle', text: 'Idle' },
            ]),
          );
        case 'pane_previews':
          return {
            [PANE_CODEX]: [
              { url: 'http://localhost:5173/', port: 5173, networkUrl: 'http://192.168.1.23:5173/' },
              { url: 'http://localhost:3000', port: 3000 },
            ],
          };
        case 'pane_jobs_all':
          return {
            [PANE_CODEX]: [
              { pid: 4120, parentPid: 3900, name: 'node', command: 'node node_modules/vite/bin/vite.js', startedAtMs: Date.now() - 12 * 60_000, ports: [5173] },
              { pid: 4188, parentPid: 3900, name: 'python', command: 'python -m pytest --watch', startedAtMs: Date.now() - 95_000, ports: [] },
            ],
          };
        case 'loop_signals':
          return scenario.name === 'loop-stuck'
            ? [
                {
                  pane_id: PANE_CLAUDE,
                  kind: 'repeated_error',
                  evidence_lines: [
                    'error[E0432]: unresolved import `crate::store::Cache`',
                    'error: could not compile `app` due to 1 previous error',
                  ],
                  turns: 4,
                  since: 0,
                  summary: 'the same error 4 times',
                },
              ]
            : [];
        case 'loop_settings_get':
          return { enabled: true, turns: 4, stalled_minutes: 20, panic_shortcut: false };
        case 'stop_all_agents':
          return {
            stopped: panes
              .filter((p) => p.status === 'running')
              .map((p) => ({ pane_id: p.id, agent_type: p.agent_type, cwd: p.cwd })),
            failed: [],
          };
        case 'agent_signin_start':
          return { pane_id: 'hidden-signin-1' };
        case 'agent_signin_status':
          return { alive: true, asking: false, pane_id: 'hidden-signin-1' };
        case 'agent_signin_stop':
          return null;
        case 'usage_snapshot':
          return scenario.usage ?? { rows: [], refreshed_at_ms: Date.now() };
        case 'canary_status':
          return scenario.canary ?? { agents: [], auto_check: true, notices: [], captures: 0 };
        case 'canary_set_auto':
          return { ...(scenario.canary ?? { agents: [], notices: [], captures: 0 }), auto_check: a.on };
        case 'canary_check':
          return (scenario.canary?.agents ?? []).find((x) => x.agent === a.agent) ?? null;
        case 'canary_dismiss_notice':
          return null;
        case 'canary_open_captures':
          return 'C:\Users\dev\AppData\Roaming\com.potatodev.workspace\captures';
        case 'app_update_check':
          return scenario.appUpdate ? { currentVersion: '1.0.27', version: scenario.appUpdate.version, notes: null } : null;
        case 'app_update_busy':
          return scenario.appUpdate?.busy ?? { agents: [], chats: [], terminals: [] };
        case 'app_update_install':
          return scenario.appUpdate?.busy?.agents.length ? Promise.reject(new Error('UPDATE_RUNNING: An agent is working.')) : null;
        case 'agents_health':
          return { agents: DOCTOR_ROWS };
        case 'agents_install_plan': {
          const mode = scenario.doctorInstall?.plan ?? 'winget';
          const missing = DOCTOR_ROWS.find((r) => r.id === a.agentId) ?? DOCTOR_ROWS[2];
          const step = (index: number, label: string, tool: string | null, method: string, command: string, host: string, risk = false, note = '') => ({
            index, label, tool, method, command, source: `https://${host}/docs`, source_host: host, high_risk: risk, note,
          });
          if (mode === 'blocked') {
            return { agent_id: missing.id, label: missing.label, available: false, steps: [], hint: missing.install_hint, reason: 'This PC cannot install apps from the command line (winget is missing). Use the command below, or download it from the website.' };
          }
          const main =
            mode === 'script'
              ? step(0, missing.label, null, 'script', "irm 'https://opencode.ai/install.ps1' | iex", 'opencode.ai', true)
              : step(0, missing.label, null, mode === 'prereq' ? 'npm' : 'winget', mode === 'prereq' ? 'npm install -g opencode-ai' : 'winget install --id SST.opencode -e --source winget', 'opencode.ai', false, 'OpenCode runs best inside WSL, but the Windows version works.');
          const steps = mode === 'prereq'
            ? [step(0, 'Node.js', 'node', 'winget', 'winget install --id OpenJS.NodeJS.LTS -e --source winget', 'nodejs.org'), { ...main, index: 1 }]
            : [main];
          return { agent_id: missing.id, label: missing.label, available: true, reason: null, hint: missing.install_hint, steps };
        }
        case 'agents_install_run':
          return { pane_id: 'pane-install-1', command: a.shownCommand, label: 'OpenCode' };
        case 'agents_install_status': {
          const after = scenario.doctorInstall?.after ?? 'running';
          if (after === 'running') return { known: true, done: false, exit_code: null, message: null };
          if (after === 'cancelled') return { known: true, done: true, exit_code: 1223, message: 'The install was cancelled in the Windows prompt.' };
          return { known: true, done: true, exit_code: 0, message: null };
        }
        case 'agents_install_finish': {
          const after = scenario.doctorInstall?.after ?? 'running';
          const installed = { ...DOCTOR_ROWS[2], state: 'unchecked', installed: true, version: '1.18.33', reason: 'Installed. Press Test to check it can answer.', can_test: true };
          if (after === 'done_ok') return { path_added: ['C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links'], health: installed, needs_restart: false };
          if (after === 'restart') return { path_added: [], health: DOCTOR_ROWS[2], needs_restart: true };
          return { path_added: [], health: DOCTOR_ROWS[2], needs_restart: false };
        }
        case 'agents_health_test':
          return { ...DOCTOR_ROWS[0], state: 'ready', reason: 'Ready. It answered the test question.' };
        case 'mcp_tools_drift':
          return [{ paneId: 'pane-demo', agentCatalog: '0f3a91c2d8b46e17', appCatalog: 'cee25c6f0af83be1', canReconnect: true }];
        case 'mcp_reconnect':
          return null;
        // Project guide (Labs): a small finished guide, so the tab can be looked at in the browser mock.
        case 'guide_state':
          return {
            enabled: true,
            hasGuide: true,
            structure: {
              commit: 'a1b2c3d', writtenAtMs: Date.now() - 3 * 86_400_000, agent: 'claude', model: null, complete: true, diagram: true, diagramStale: false,
              pages: [
                { id: 'overview', title: 'Overview', purpose: 'What it is', stale: false, needsReview: false },
                { id: 'sync', title: 'Sync', purpose: 'How sync works', stale: true, needsReview: false },
              ],
            },
            run: null,
            last: null,
            dryRun: true,
          };
        case 'guide_read_page':
          return { id: 'overview', title: 'Overview', markdown: '# Overview\n\nA small notes app. The queue is in [[src/sync/queue.ts:40-88]].', stale: false, changed: [], needsReview: false };
        case 'guide_read_diagram':
          return { mermaid: 'flowchart LR\n  n0["Overview"]\n  n1["Sync"]\n  n0 --> n1\n', boxes: [{ label: 'Overview', path: 'src/main.ts', page: 'overview' }], stale: false };
        case 'guide_stop':
        case 'guide_delete':
          return true;
        case 'get_mcp_status':
          return {
            bridgeReachable: true,
            bridgeUrl: 'http://127.0.0.1:17421',
            bridgeVersion: '0.1.4',
            portFileExists: true,
            portFilePath: 'C:\Users\dev\.potato-workspace\bridge.port',
            nodeAvailable: true,
            npmAvailable: true,
            npmPackageVersion: '0.1.4',
            launchCommand: 'npx -y @potato-workspace/mcp',
            backends: [],
            overallReady: true,
            repairResults: [],
          };
        case 'install_npm_mcp_configs':
          return [
            { backend: 'claude_cli', installed: true, changed: true, message: 'Claude project MCP configured for potato-workspace' },
            { backend: 'codex_cli', installed: true, changed: false, message: 'Codex project MCP already set' },
            { backend: 'opencode_cli', installed: true, changed: true, message: 'OpenCode project MCP configured for potato-workspace' },
          ];
        case 'install_global_npm_mcp_configs':
          return [
            { backend: 'claude_cli_global', installed: true, changed: true, message: 'Claude user MCP configured for potato-workspace' },
            { backend: 'codex_cli_global', installed: true, changed: true, message: 'Codex global MCP configured for potato-workspace' },
            { backend: 'opencode_cli_global', installed: true, changed: false, message: 'OpenCode global MCP already set' },
          ];
        case 'list_agent_contexts':
          return [];
        case 'secret_storage_info':
          return { secure: true, label: 'Windows Credential Manager' };
        case 'secret_get_masked':
          return a.name === 'anthropic_api_key' ? { set: true, last4: 'WXYZ' } : { set: false, last4: null };
        case 'secret_get_custom_ai_key':
          return null;
        case 'get_opencode_key_status':
          return { active_profile: 'a', profiles: [{ id: 'a', label: 'Primary', configured: true }, { id: 'b', label: 'Secondary', configured: false }], key_automation_mode: 'notify_only', restart_pane_on_rotate: true };
        // Chat sessions (ACP) are off in the preview: no agent offers Chat, and no terminal holds a conversation.
        case 'agent_lane_get':
          // A scenario can turn Chat on for Claude (`window.__chatLane`), e.g. to show the live model list.
          if ((window as unknown as { __chatLane?: boolean }).__chatLane) return { labs_enabled: true, agents: [{ id: 'claude', lane: 'acp', disabled: false }] };
          if (scenario.chatFirst) return { labs_enabled: true, agents: ['claude', 'codex'].map((id) => ({ id, label: id, lane: 'terminal', effective_lane: 'terminal', saved: false, helper_lane: 'acp', disabled: false, disabled_note: null })), can_add_chat: [], terminal_chat: [] };
          return { labs_enabled: false, agents: [] };
        // The Chat tab opens the pane's session file; the preview has none, so it says "not available" (a null answer blanked the page).
        case 'session_chat_open':
          return { available: false, reason: 'No session file in the preview.', items: [], source: null, waitingFor: null };
        case 'session_chat_close':
          return null;
        // A picture attached to a message (image-viewer-preview): an svg whose shape follows the file name.
        case 'attachment_preview': {
          const path = String(a.path ?? '');
          const [w, h] = path.includes('wide') ? [1600, 600] : path.includes('tall') ? [500, 1500] : [900, 560];
          const hue = path.includes('two-b') ? '#2a8fd9' : '#d9772a';
          return 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#f4f1ea"/><rect x="6" y="6" width="${w - 12}" height="${h - 12}" fill="none" stroke="${hue}" stroke-width="8"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="${hue}"/><text x="24" y="48" font-family="sans-serif" font-size="32" fill="#333">${w} x ${h}</text><text x="24" y="${h - 24}" font-family="sans-serif" font-size="32" fill="#333">bottom edge</text></svg>`);
        }
        // A picture the agent named (chat-more-preview): a small bar chart drawn as a data URL.
        case 'chat_picture':
          return { name: 'sales.png', mime: 'image/svg+xml', size: 900, dataUrl: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220" viewBox="0 0 420 220"><rect width="420" height="220" fill="#f4f1ea"/><g fill="#d9772a"><rect x="40" y="110" width="50" height="90"/><rect x="120" y="80" width="50" height="120"/><rect x="200" y="30" width="50" height="170"/><rect x="280" y="90" width="50" height="110"/></g><g fill="#444" font-family="sans-serif" font-size="12"><text x="52" y="214">W1</text><text x="132" y="214">W2</text><text x="212" y="214">W3</text><text x="292" y="214">W4</text></g></svg>') };
        case 'acp_conversation_of_terminal':
          return null;
        // The model pickers: Claude starts a pane on a model; every other agent lists none in the preview.
        case 'agent_model_options':
          // `live` is what the agent's chats last reported (the chat picker's list).
          // `window.__mixedModels`: a list that spans makers (the model picker's grouping).
          if (a.agentId === 'claude' && (window as unknown as { __mixedModels?: boolean }).__mixedModels) return { terminal: false, default_model: null, models: [], live: { options: [
            { value: 'default', name: 'Default', description: null },
            { value: 'argon', name: 'Gemini 4 Argon', description: null },
            { value: 'hydrogen', name: 'Gemini 4 Hydrogen', description: null },
            { value: 'orch', name: 'Orchestrator (Argon)', description: null },
            { value: 'flash', name: 'Gemini 3.8 Flash', description: null },
            { value: 'opus', name: 'Claude Opus 5.5', description: null },
            { value: 'sonnet', name: 'Claude Sonnet 5.5', description: null },
            { value: 'oss', name: 'GPT-OSS 120B (Medium)', description: null },
          ] } };
          if (a.agentId === 'claude') return { terminal: true, default_model: 'sonnet', models: ['opus', 'sonnet', 'haiku'], live: { options: [
            { value: 'default', name: 'Default (recommended) · Opus 5.5', description: 'Opus 5.5 with 1M context · Most capable for complex work' },
            { value: 'opus', name: 'Opus 5.5', description: 'Most capable for complex work' },
            { value: 'fable', name: 'Fable 5.2', description: 'Fast and good at everyday work' },
            { value: 'sonnet', name: 'Sonnet 5.5', description: 'Best for everyday tasks' },
            { value: 'haiku', name: 'Haiku 5.5', description: 'Fastest for quick answers' },
          ] } };
          if (a.agentId === 'opencode') {
            return { terminal: false, default_model: null, models: ['opencode-go/deepseek-v4.1-flash', 'opencode-go/glm-5', 'opencode-go/kimi-k2.5', 'opencode/big-pickle', 'opencode/gpt-5-nano', 'anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5', 'openai/gpt-5.1', 'openai/gpt-5-mini', 'google/gemini-2.5-pro'] };
          }
          return { terminal: false, default_model: null, models: [] };
        case 'agent_run_mode_get':
        case 'agent_run_mode_set':
          // The dev harness has no custom agents to choose for.
          return { agents: [] };
        case 'started_agents_get':
          return { types: 'one', kind: 'agent_chooses' };
        case 'started_agents_set':
          return { types: a.types ?? 'one', kind: a.kind ?? 'agent_chooses' };
        case 'helper_visibility_get':
          return { mode: 'always_show' };
        case 'helper_visibility_set':
          return { mode: String(a.mode) };
        case 'keep_helpers_open_get':
          return { on: true };
        case 'keep_helpers_open_set':
          return { on: Boolean(a.on) };
        case 'close_helpers_with_agent_get':
          return { on: true };
        case 'close_helpers_with_agent_set':
          return { on: Boolean(a.on) };
        case 'stall_minutes_get':
          return { value: 5 };
        case 'stall_minutes_set':
          return { value: Number(a.value) };
        case 'stalls_list':
          return [];
        case 'most_helpers_at_once_get':
          return { value: 8 };
        case 'most_helpers_at_once_set':
          return { value: Number(a.value) };
        case 'hidden_runs_list':
          return [];
        case 'hidden_runs_dismiss':
          return false;
        case 'agent_authority_get':
          return authority;
        case 'agent_authority_set': {
          authority = {
            ask_before_agent_control: (a.askBeforeAgentControl as boolean | undefined) ?? authority.ask_before_agent_control,
            agents_may_merge: (a.agentsMayMerge as boolean | undefined) ?? authority.agents_may_merge,
            ask_before_helpers_start: (a.askBeforeHelpersStart as boolean | undefined) ?? authority.ask_before_helpers_start,
          };
          return authority;
        }
        case 'audit_recent':
          return scenario.audit ?? [];
        case 'audit_verify':
          return { ok: true, entries: (scenario.audit ?? []).length, broken: null };
        case 'questions_list':
          return scenario.questions ?? [];
        case 'question_answer':
        case 'question_dismiss':
          return { accepted: true, question: (scenario.questions ?? []).find((q) => q.id === a.id) };
        case 'get_tunnel_status':
        case 'set_tunnel_config': {
          if (scenario.tunnel === 'quick-error') {
            return {
              mode: 'quick',
              public_url: null,
              state: 'error',
              error: 'cloudflared stopped: no quick address was given (exit 1).',
              problem: 'too_soon',
              retry_in_secs: 240,
              config: { mode: 'quick', hostname: null, url: null, has_token: false },
            };
          }
          if (scenario.tunnel === 'quick') {
            return {
              mode: 'quick',
              public_url: 'https://quiet-lake-1234.trycloudflare.com',
              state: 'running',
              error: null,
              config: { mode: 'quick', hostname: null, url: null, has_token: false },
            };
          }
          if (scenario.tunnel) {
            const failed = scenario.tunnel === 'stable-failed';
            const worker = 'https://potato-stable-link.example.workers.dev';
            const shown = a.input && (a.input as { secret_action?: string }).secret_action === 'show';
            return {
              mode: 'stable',
              public_url: worker,
              state: 'running',
              error: null,
              config: { mode: 'stable', hostname: null, url: worker, has_token: false, has_secret: true },
              stable: {
                worker_url: worker,
                quick_url: 'https://quiet-lake-1234.trycloudflare.com',
                link: failed ? 'failed' : 'linked',
                error: failed ? 'The secret does not match the one the Worker has. Make a new secret, or reset the Worker.' : null,
              },
              ...(shown ? { secret_once: 'k3Qm9x-EXAMPLE-ONLY-vT7pL2dRw8YzN1uHa5bC0eJ' } : {}),
            };
          }
          return {
            mode: 'named',
            public_url: 'https://pm.example.com',
            state: 'running',
            error: null,
            config: { mode: 'named', hostname: 'pm.example.com', url: null, has_token: true },
          };
        }
        case 'test_tunnel_connection':
          return { ok: true, url: 'https://pm.example.com/bridge/health', http_status: 200, latency_ms: 84, message: 'Connected in 84 ms.' };
        case 'create_mobile_pairing_session': {
          const url = String(a.bridgeUrl ?? 'https://pm.example.com/bridge');
          return {
            pairing_code: 'K7Q2-M9XD',
            expires_at: 1_900_000_000,
            server_public_key: 'bW9jay1zZXJ2ZXItcHVibGljLWtleQ==',
            bridge_url: url,
            qr_payload: { v: 1, u: url, pk: 'bW9jay1zZXJ2ZXItcHVibGljLWtleQ==', c: 'K7Q2M9XD', e: 1_900_000_000 },
          };
        }
        case 'get_desk_away':
          return desk;
        case 'start_desk_away':
          desk = { away: true, length: a.length as DeskLength, until_ms: a.length === 'until_back' ? null : Date.now() + 3_600_000, by: 'pc', lock_screen: a.lockScreen === true, phones: desk.phones };
          return desk;
        case 'end_desk_away':
          desk = { away: false, lock_screen: false, phones: desk.phones };
          return desk;
        case 'get_pane_remote':
          return paneRemote[a.paneId as string] ?? { remote: true, level: 'full' };
        case 'set_pane_remote': {
          const next = { ...(paneRemote[a.paneId as string] ?? { remote: true, level: 'full' }), ...(a.remote === undefined ? {} : { remote: a.remote }), ...(a.level === undefined ? {} : { level: a.level }) };
          paneRemote[a.paneId as string] = next as { remote: boolean; level: string };
          return next;
        }
        case 'list_paired_mobile_devices':
          return pairedDevices;
        case 'phone_activity_list':
          return scenario.phoneActivity ?? [];
        case 'phone_activity_clear':
          scenario.phoneActivity = [];
          return true;
        case 'set_paired_mobile_device_caps': {
          const device = pairedDevices.find((d) => d.id === a.deviceId);
          if (device) device.caps = (a.caps as string[]) ?? [];
          return Boolean(device);
        }
        case 'rename_paired_mobile_device': {
          const device = pairedDevices.find((d) => d.id === a.deviceId);
          if (device && String(a.name ?? '').trim()) device.name = String(a.name).trim();
          return Boolean(device);
        }
        case 'revoke_paired_mobile_device': {
          const before = pairedDevices.length;
          pairedDevices = pairedDevices.filter((d) => d.id !== a.deviceId);
          return pairedDevices.length !== before;
        }
        case 'get_mobile_tunnel_info':
        {
          const shown = scenario.tunnel === 'quick' || scenario.tunnel === 'quick-error' ? 'https://quiet-lake-1234.trycloudflare.com' : scenario.tunnel ? 'https://potato-stable-link.example.workers.dev' : 'https://pm.example.com';
          return { localUrl: 'http://127.0.0.1:1420', pwaUrl: 'http://127.0.0.1:1420', tunnelUrl: shown, bridgeProxyUrl: `${shown}/bridge`, updatedAt: 0 };
        }
        case 'pane_set_title':
          return String(a.title ?? '') || null;
        case 'agent_pack_preview':
          return AGENT_PACK_PREVIEW;
        case 'agent_pack_apply':
          return { ...AGENT_PACK_PREVIEW, dry_run: false, recorded: 9 };
        case 'agent_pack_inspect':
          return AGENT_PACK_INSPECTION;
        case 'agent_pack_custom_save':
          return { id: String(a.agentId ?? 'custom-agent'), name: String(a.name ?? 'Agent'), config_path: String(a.path ?? ''), format: 'json', key_path: 'mcpServers' };
        case 'agent_pack_custom_forget':
          return { removed: true };
        case 'agents_definitions_removed':
          return { removed: [], total: 0 };
        case 'plugin:dialog|open':
          return (a.options as { directory?: boolean } | undefined)?.directory ? 'C:\\Users\\dev\\.agy\\skills' : 'C:\\Users\\dev\\.agy\\settings.json';
        case 'agent_pack_undo':
          return { restored: [], removed: ['a', 'b'], skipped: [], recorded: 0 };
        case 'notify_prefs_get':
          return NOTIFY_PREFS;
        case 'notify_bell_set':
          NOTIFY_PREFS.bells[String(a.key)] = String(a.level);
          return NOTIFY_PREFS;
        case 'notify_quiet_set':
          NOTIFY_PREFS.quiet = a.quiet as typeof NOTIFY_PREFS.quiet;
          return NOTIFY_PREFS;
        case 'notify_prefs_import':
          return NOTIFY_PREFS;
        case 'notify_snooze':
          return Date.now() + 30 * 60_000;
        case 'discord_alerts_status':
        case 'discord_alerts_set_url':
        case 'discord_alerts_clear':
        case 'discord_alerts_set_kinds':
          return { saved: false, tail: null, kinds: { needs_you: true, finished: false, failed: true }, active: false };
        case 'discord_alerts_test':
          return { ok: false, message: 'Paste a webhook link and save it first.' };
        case 'toolbelt_list':
          return TOOLBELT_LISTING;
        case 'toolbelt_sync_preview':
          return TOOLBELT_PREVIEW;
        case 'toolbelt_sync_apply':
          return { ...TOOLBELT_PREVIEW, dry_run: false };
        case 'toolbelt_import_preview':
          return { candidates: TOOLBELT_IMPORT };
        case 'toolbelt_import_apply':
          return { added: [] };
        case 'shelf_state':
          if (!scenario.shelf) throw new Error('unknown command');
          return scenario.shelf;
        case 'shelf_preview':
          return previewFor(String(a?.cardId), (a?.agents as string[]) ?? [], scenario.shelf);
        case 'shelf_add': {
          const p = previewFor(String(a?.cardId), (a?.agents as string[]) ?? [], scenario.shelf);
          return { id: p.id, name: p.name, kind: p.kind, addedTo: p.writes.flatMap((w) => w.agents.map((x) => x.label)), agentIds: a?.agents, writes: p.writes, undo: 'undo-1' };
        }
        case 'shelf_suggest':
          return { sent: true, id: String(a?.itemId) };
        case 'shelf_undo':
          return { restored: 1, skipped: [] };
        case 'shelf_dismiss':
          return true;
        case 'team_default_name':
          return 'Maya';
        case 'team_state':
        case 'team_reconnect':
          return scenario.team ?? null;
        case 'team_move_relay':
          if (scenario.team) scenario.team = { ...scenario.team, link: 'live', linkDetail: null };
          return scenario.team ?? null;
        case 'team_tasks_state':
          return scenario.tasks ?? { sent: [], received: [], handoverOn: false, lendOn: false, repoCapBytes: 2 * 1024 * 1024 };
        case 'team_task_repo_check':
          return { ok: true, name: 'potato-workspace', branch: 'main', reason: '' };
        case 'team_task_pass':
        case 'team_task_withdraw':
        case 'team_task_seen':
        case 'team_task_accept':
        case 'team_task_decline':
        case 'team_task_started':
        case 'team_task_done':
        case 'team_tasks_handover_set':
          return null;
        case 'team_config_get':
        case 'team_config_set':
        case 'team_create':
        case 'team_join':
        case 'team_leave':
        case 'team_join_approve':
        case 'team_join_decline':
        case 'team_member_remove':
        case 'team_member_confirm_github':
          return teamConfig({ enabled: !!scenario.team?.enabled, name: scenario.team?.me ?? 'Leo', ...scenario.teamConfig });
        case 'team_invite': {
          const w = scenario.worker;
          return {
            link: 'pm://team/join?t=Acme&r=relay.acme.dev&k=8Vh2mQ0pXn4cD7wLrT1uYb3sZaE5gJfK',
            code: 'KQ7M-4XPD',
            expiresAtMs: Date.now() + (w?.inviteLink ? 24 * 3600_000 : 10 * 60_000),
            ...(w?.inviteLink ? { joinUrl: 'https://pm-relay.acme.workers.dev/join/KQ7M4XPDH5WZ9RTB' } : {}),
            ...(w?.inviteNote ? { joinUrlNote: w.inviteNote } : {}),
          };
        }
        case 'team_invite_lookup':
          return { host: 'pm-relay.acme.workers.dev', teamName: 'Acme crew', inviter: 'Maya', expiresAtMs: Date.now() + 20 * 3600_000 };
        case 'team_invite_accept':
          return teamConfig({ enabled: false, team: '', teamName: '', joining: 'Acme crew' });
        case 'worker_check':
          return { reachable: true, features: scenario.worker?.features ?? ['team', 'rooms', 'stable-link', 'invites'], legacyLink: false };
        case 'team_relay_deploy':
          return { status: 'done', url: 'https://pm-relay.acme.workers.dev' };
        case 'team_gaps_clear':
          return null;
        case 'team_merge_plan': {
          // What GitHub answers for the pull request (never the card's own words).
          const card = scenario.team?.cards.find((c) => c.id === a.cardId)?.event;
          const pr = card?.subject.pr;
          return {
            repo: 'acme/billing-service',
            number: pr?.number ?? 142,
            title: pr?.title ?? 'Invoice PDF export',
            author: card?.actor.display ?? 'priya-dev',
            headRef: card?.subject.branch ?? 'fix/rounding',
            headSha: 'e04bc0145a89bb85472ac53fa26cedc9f64a326f',
            baseRef: card?.subject.base ?? 'main',
            method: 'squash',
            methodWords: 'squashed into one commit',
            autoMergeOff: false,
          };
        }
        case 'team_merge_when_green': {
          const pr = scenario.team?.cards.find((c) => c.id === a.cardId)?.event.subject.pr;
          return `GitHub will merge #${pr?.number ?? 142} when its checks pass. Nothing was merged yet.`;
        }
        case 'team_job_diff':
          return TEAM_DIFF;
        case 'team_send':
        case 'team_draft_dismiss':
        case 'team_card_dismiss':
        case 'team_ci_claim':
        case 'team_job_discard':
        case 'team_job_start':
          return null;
        case 'team_pull':
          return 'Pulled feat/auth. You are at 3f9c2a1.';
        case 'team_job_apply':
          return 'Applied to feat/billing. Nothing was pushed.';
        case 'memory_get':
        case 'memory_sync':
        case 'memory_save':
        case 'memory_set_project_enabled':
          return memoryView(typeof a.text === 'string' ? a.text : undefined);
        case 'memory_global_enabled':
          return true;
        case 'one_brain_remember':
          return { added: true, text: typeof a.text === 'string' ? a.text : '', view: memoryView() };
        case 'one_brain_forget':
          return memoryView();
        case 'one_brain_set_project_enabled':
          return memoryView();
        case 'askbar_settings_get':
          return { enabled: true, shortcut: 'Ctrl+Alt+Space', default_agent: 'claude', last_agent: null, attach_clipboard_default: false };
        case 'askbar_settings_set':
          return a.settings;
        case 'askbar_agents':
          return [
            { id: 'claude', label: 'Claude', ready: true },
            { id: 'codex', label: 'Codex', ready: false },
            { id: 'cursor_agent', label: 'Cursor Agent', ready: false },
          ];
        case 'askbar_clipboard':
          return { text: 'x'.repeat(1200), chars: 1200, truncated: false };
        case 'askbar_resize': {
          // The real window is 640 wide and 64 or 420 tall; mimic it so screenshots look like the window.
          const root = document.getElementById('root');
          if (root) {
            root.style.width = '640px';
            root.style.height = a.expanded ? '420px' : '64px';
            root.style.margin = '48px auto 0';
          }
          return null;
        }
        case 'askbar_hide':
        case 'askbar_continue':
        case 'askbar_notice_dismiss':
        case 'askbar_notice_open':
          return null;
        case 'askbar_notices':
          return [];
        case 'askbar_ask': {
          const req = a.request as { ask_id: string; question: string };
          return new Promise((resolve) =>
            window.setTimeout(
              () =>
                resolve({
                  ask_id: req.ask_id,
                  agent: 'claude',
                  agent_label: 'Claude',
                  question: req.question,
                  ok: true,
                  answer:
                    'Short answer: use a `Mutex<HashMap<..>>` only for the index and keep the rows in an `Arc`.\n\n```rust\nlet index = Arc::new(Mutex::new(HashMap::new()));\nindex.lock().insert(id, row);\n```\n\nThat keeps the lock short and the reads cheap.',
                  error: null,
                }),
              400,
            ),
          );
        }
        case 'resize_pane':
        case 'set_ui_mode':
        case 'interrupt_pane':
        case 'answer_pane_prompt':
          return null;
        case 'settings_patch': {
          // The Rust command in miniature: merge only the patched keys, null removes, ui_mode is not ours.
          const current = { ...((store.get('settings') as Record<string, unknown> | undefined) ?? {}) };
          for (const [key, value] of Object.entries((a.patch ?? {}) as Record<string, unknown>)) {
            if (key === 'ui_mode') continue;
            if (value === null) delete current[key];
            else current[key] = value;
          }
          store.set('settings', current);
          return current;
        }
        case 'diagnostic_preview':
          return {
            totalBytes: 41_530,
            files: [
              { path: 'README.txt', label: 'A short note on what this file is', bytes: 812 },
              { path: 'version.json', label: 'App and system versions', bytes: 148 },
              { path: 'settings.json', label: 'Your settings, with keys and tokens removed', bytes: 1_204 },
              { path: 'app-log.txt', label: "The last 400 lines of the app's log", bytes: 31_870 },
              { path: 'recordings/op-1.cast', label: 'Recording of a run that failed, 2 hours ago', bytes: 7_496 },
            ],
          };
        case 'diagnostic_show':
          return ['{', '  "app": "Potato Workspace",', '  "version": "0.9.0",', '  "os": "windows"', '}'].join('\n');
        case 'diagnostic_save':
          return { path: String(a.path ?? ''), files: 6, bytes: 9_120 };
        case 'plugin:dialog|save':
          return 'C:\\Users\\dev\\Desktop\\potato-workspace-diagnostic.zip';
        case 'autostart_get':
          return false;
        case 'autostart_set':
          return Boolean(a.enabled);
        case 'uninstall_allowed': {
          // `?uninstall=blocked` shows the dev-build refusal.
          const blocked = typeof location !== 'undefined' && new URLSearchParams(location.search).get('uninstall') === 'blocked';
          return { allowed: !blocked, reason: blocked ? 'Not in the dev build' : null };
        }
        case 'uninstall_plan':
          return FAKE_UNINSTALL_PLAN;
        case 'uninstall_run':
          return runFakeUninstall();
        case 'settings_reset':
          return {};
        case 'get_app_install_info':
          return {
            version: '0.9.0',
            isPackaged: true,
            platform: 'windows',
            uninstallAvailable: true,
            uninstallInstructions: 'Removes Potato Workspace with the Windows uninstaller.',
            dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\com.potatodev.workspace',
          };
        case 'get_coordination_storage_info':
          return {
            scope: 'project',
            project_path: 'C:\\Users\\dev\\work\\potato-workspace',
            storage_dir: 'C:\\Users\\dev\\work\\potato-workspace\\.potato-workspace',
            event_log_path: 'C:\\Users\\dev\\work\\potato-workspace\\.potato-workspace\\events.jsonl',
            event_count: 148,
            task_count: 3,
            lock_count: 1,
            exists: true,
          };
        // plugin-store
        case 'plugin:store|get_store':
        case 'plugin:store|load':
          return 1;
        case 'plugin:store|get': {
          const key = String(a.key);
          return [store.get(key) ?? null, store.has(key)];
        }
        case 'plugin:store|set':
          store.set(String(a.key), a.value);
          return null;
        case 'plugin:store|has':
          return store.has(String(a.key));
        case 'plugin:store|keys':
          return [...store.keys()];
        case 'plugin:store|save':
          return null;
        default:
          if (cmd.startsWith('plugin:event|') || cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:path|')) {
            return null;
          }
          console.warn(`[harness] unmocked Tauri command: ${cmd}`, args);
          return null;
      }
    },
    { shouldMockEvents: true },
  );
}

const MEMORY_TEXT = [
  '# potato-workspace',
  '',
  'Desktop app: Tauri 2 (Rust) + React. Backend logic stays in Rust.',
  '',
  '- Run tests: cargo test --lib, npm test --workspace=@potato-workspace/app',
  '- UI is monochrome, see mockups/ui-proposal/STYLE.md',
  '- Never push; commit small and revertable',
].join('\n');

function memoryView(text?: string) {
  return {
    project: 'C:\\Users\\dev\\work\\potato-workspace',
    memory: text ?? MEMORY_TEXT,
    global_enabled: true,
    project_enabled: true,
    report: null,
    targets: [
      { path: 'CLAUDE.md', agents: ['claude'], status: 'in_sync', user_content: true },
      { path: 'AGENTS.md', agents: ['codex', 'opencode'], status: 'will_update', user_content: true },
      { path: '.cursor/rules/potato-workspace.mdc', agents: ['cursor_agent'], status: 'will_create', user_content: false },
    ],
  };
}
