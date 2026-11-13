// Settings > General: project folder, appearance, safety nets (confirm close, loop guard, checkpoints,
// project memory, away digest), coordination storage, version and updates, export and uninstall.
// This section is the reference for the others: rows are plain data (`RowDef`), each control saves itself.
import { QuietHoursRow } from '../NotifyRows';
import { errorSentence } from '../../../lib/sayError';
import { useCallback, useEffect, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { Settings } from '@potato-workspace/shared';
import { clampAwayMinutes, clampCheckpointsKeep } from '../../../lib/bridge-settings';
import { redactSettings } from '../../../lib/secrets';
import { resolveSettingsFilePath } from '../../../lib/settings';
import { cockpitApi } from '../../../lib/cockpit-api';
import { parseSwitchStyle, parseWindowLayout, type SwitchStyle } from '../../../lib/mode-switch/model';
import { t, useT } from '../../../i18n';
import { styleLabel } from '../i18n-labels';
import { tauri, type AppInstallInfo, type CoordinationStorageInfo } from '../../../lib/tauri';
import { budgetRows } from './BudgetRows';
import { AskBarSettingsBlock } from '../blocks/AskBarSettings';
import { AssignIssueSettings } from '../blocks/AssignIssueSettings';
import { BringChatsSettings } from '../blocks/BringChatsSettings';
import { ChatIndexSettings } from '../blocks/ChatIndexSettings';
import { CiFixSettings } from '../blocks/CiFixSettings';
import { DiagnosticFile } from '../blocks/DiagnosticFile';
import { DiscordAlertsBlock } from '../blocks/DiscordAlerts';
import { LiveRoomRow } from '../blocks/LiveRoomRow';
import { LoopGuardSettingsBlock } from '../blocks/LoopGuardSettings';
import { SharedMemoryToggle } from '../blocks/SharedMemoryToggle';
import { START_AT_SIGN_IN_HINT, START_AT_SIGN_IN_LABEL, StartAtSignInSettings } from '../blocks/StartAtSignInSettings';
import { WhatsNew, WHATS_NEW_LABEL } from '../blocks/WhatsNew';
import { NumberControl, TextControl } from '../controls';
import { LayoutThumbs, ThemeThumbs } from '../previews/Thumbs';
import type { RowDef, SettingsEnv } from '../model';
import { PACKAGE_CHECK_LABEL, PACKAGE_CHECK_NOTE, PackageCheckRow } from './PackageCheckRow';
import { comfortRows } from './ComfortRows';
import { T as WELCOME } from '../../firstrun/copy';
import { reopenPatch } from '../../firstrun/model';
import { Btn, FieldSelect, InfoRow, Note, SettingBlock, SettingRow, SettingToggle } from '../settings-ui';
import { LabsSwitch } from '../LabsSwitch';
import { languageRow } from './LanguageRow';
import { RECOVERY_HINT, RECOVERY_LABEL } from '../../../lib/settings-recovery';
import { SettingsRecoveryRow } from './SettingsRecoveryRow';
import { UpdateRow } from './UpdateRow';

function useInstallInfo(): AppInstallInfo | null {
  const [info, setInfo] = useState<AppInstallInfo | null>(null);
  useEffect(() => {
    void tauri.getAppInstallInfo().then(setInfo).catch(() => undefined);
  }, []);
  return info;
}

// ---------- project folder ----------

/** An example path in the empty field: code, the same in every language. */
const PROJECT_EXAMPLE = '~/work/my-project';

function ProjectFolder({ env }: { env: SettingsEnv }) {
  const value = env.projectPath ?? env.settings.project_path ?? '';
  const save = async (path: string) => {
    env.setError(null);
    try {
      if (env.onProjectPathChange) await env.onProjectPathChange(path);
      else await env.patch({ project_path: path || null });
      env.markSaved();
    } catch (error) {
      env.setError(t('settings.notSaved', { reason: errorSentence(error) }));
    }
  };
  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: (await homeDir()) ?? value ?? undefined });
    if (typeof picked === 'string') await save(picked);
  };
  return (
    // A block, not a row: a folder path is long, and a 220px field on the right showed "C:\Users\dev\work".
    <SettingBlock label={t('settings.row.project-folder.label')} description={t('settings.row.project-folder.hint')}>
      <div className="st-path">
        <TextControl
          aria-label={t('settings.row.project-folder.label')}
          mono
          title={value}
          value={value}
          placeholder={PROJECT_EXAMPLE}
          normalize={(text) => text.trim()}
          onCommit={save}
        />
        <Btn onClick={() => void browse()}>{t('general.browse')}</Btn>
      </div>
    </SettingBlock>
  );
}

// ---------- coordination storage ----------

function StorageInfo({ env }: { env: SettingsEnv }) {
  const t = useT();
  const [info, setInfo] = useState<CoordinationStorageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setError(null);
      setInfo(await tauri.getCoordinationStorageInfo());
    } catch (e) {
      setError(errorSentence(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh, env.projectPath]);
  return (
    <>
      <InfoRow
        label={t('settings.row.storage.label')}
        description={t('settings.row.storage.hint')}
        value={info ? (info.scope === 'project' ? t('general.projectFolder') : t('general.sharedFallback')) : '…'}
      />
      <InfoRow label={t('general.tasks')} value={info ? String(info.task_count) : '…'} />
      <InfoRow label={t('general.fileLocks')} value={info ? String(info.lock_count) : '…'} />
      <InfoRow
        label={t('general.eventLog')}
        description={info?.event_log_path ?? t('teamPage.loading')}
        value={info ? t('general.events', { count: info.event_count, created: info.exists ? '' : ` ${t('general.createdOnWrite')}` }) : '…'}
      />
      <SettingRow label={t('general.storageFolder')} description={info?.storage_dir ?? t('teamPage.loading')}>
        <Btn onClick={() => void refresh()}>{t('security.refresh')}</Btn>
      </SettingRow>
      {error && <Note role="alert">{error}</Note>}
    </>
  );
}

// ---------- version and updates ----------

function VersionRow() {
  const t = useT();
  const info = useInstallInfo();
  return <UpdateRow versionLine={info ? `${info.version.replace(/^v/i, '')}${info.isPackaged ? '' : t('overview.version.devBuild')}` : '…'} />;
}

// ---------- export and uninstall ----------

function exportSettings(settings: Settings) {
  const blob = new Blob([JSON.stringify(redactSettings(settings), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'potato-workspace-settings.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function SettingsFile({ env }: { env: SettingsEnv }) {
  const t = useT();
  const [path, setPath] = useState('settings.json');
  useEffect(() => {
    void resolveSettingsFilePath().then(setPath);
  }, []);
  return (
    <SettingRow label={t('settings.row.settings-file.label')} description={path}>
      <Btn onClick={() => exportSettings(env.settings)}>{t('general.export')}</Btn>
    </SettingRow>
  );
}

function UninstallRow({ env }: { env: SettingsEnv }) {
  const t = useT();
  const info = useInstallInfo();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    env.setError(null);
    const ok = await env.confirm({
      title: t('general.uninstallTitle'),
      body: t('general.uninstallBody'),
      confirmLabel: t('bridge.uninstall'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await tauri.launchUninstall();
    } catch (error) {
      env.setError(errorSentence(error));
      setBusy(false);
    }
  };
  const description = info
    ? info.uninstallAvailable
      ? `${info.uninstallInstructions}${info.dataDir ? ` ${t('general.appData', { dir: info.dataDir })}` : ''}`
      : t('general.uninstallDev')
    : t('teamPage.loading');
  return (
    <SettingRow label={t('settings.row.uninstall.label')} description={description}>
      <Btn disabled={busy || !info?.uninstallAvailable} onClick={() => void run()}>
        {busy ? t('general.uninstalling') : t('general.uninstallDots')}
      </Btn>
    </SettingRow>
  );
}

/** The Welcome row's own name: it runs the first-run setup again. */
const SIMPLE_LABEL = 'Simple look';
const SIMPLE_HINT = 'A calmer screen with fewer buttons and plain words.';
const WELCOME_LABEL = 'Run setup again';

/** The away setting in words, beside its field. */
export const awayWords = (minutes: number): string => (minutes <= 0 ? t('lookFeel.away.off') : t('lookFeel.away.after', { count: minutes }));

const SWITCH_STYLES: SwitchStyle[] = ['domino', 'ink', 'off'];
const SWITCH_HINT = 'How windows move when you switch modes. Off is a quick fade.';

function ModeSwitchRow({ env }: { env: SettingsEnv }) {
  const t = useT();
  const style = parseSwitchStyle(env.settings.mode_switch_animation);
  return (
    <SettingRow label={t('lookFeel.modeSwitch.label')} description={t('lookFeel.modeSwitch.hint')}>
      <FieldSelect
        aria-label={t('lookFeel.modeSwitch.label')}
        value={style}
        onChange={(e) => void env.patch({ mode_switch_animation: parseSwitchStyle(e.target.value) })}
      >
        {SWITCH_STYLES.map((value) => (
          <option key={value} value={value}>
            {styleLabel(value)}
          </option>
        ))}
      </FieldSelect>
    </SettingRow>
  );
}

const LAYOUT_HINT = 'Where windows go in Individual: side by side in rows, or Cascade.';

function WindowLayoutRow({ env }: { env: SettingsEnv }) {
  const t = useT();
  return (
    <SettingRow label={t('lookFeel.layout.label')} description={t('lookFeel.layout.hint')}>
      <LayoutThumbs
        value={parseWindowLayout(env.settings.individual_window_layout)}
        onPick={(layout) => void env.patch({ individual_window_layout: layout })}
      />
    </SettingRow>
  );
}

// ---------- the rows ----------

export const generalRows: RowDef[] = [
  ...comfortRows,
  { id: 'project-folder', label: 'Default project folder', hint: 'Where new panes and agents start.', keywords: 'workspace directory browse path', group: 'Project', render: (env) => <ProjectFolder env={env} /> },
  {
    id: 'your-name',
    label: 'Your name',
    hint: 'Used in the greeting on the New agent page. Leave it empty for no name.',
    keywords: 'name greeting hello welcome new agent page profile display',
    group: 'Appearance',
    render: (env) => (
      <SettingRow label={t('lookFeel.yourName.label')} description={t('lookFeel.yourName.hint')}>
        <TextControl
          aria-label={t('lookFeel.yourName.label')}
          value={env.settings.display_name ?? ''}
          mode="blur"
          maxLength={60}
          placeholder={t('lookFeel.yourName.placeholder')}
          normalize={(text) => text.replace(/\s+/g, ' ').trim()}
          onCommit={(next) => env.patch({ display_name: next || null })}
        />
      </SettingRow>
    ),
  },
  {
    id: 'start-at-sign-in',
    label: START_AT_SIGN_IN_LABEL,
    hint: START_AT_SIGN_IN_HINT,
    keywords: 'autostart auto start startup boot login sign in windows launch tray companion reboot restart',
    group: 'Startup',
    render: (env) => <StartAtSignInSettings onSaved={env.markSaved} />,
  },
  {
    id: 'theme',
    label: 'Theme',
    hint: 'Dark or light.',
    keywords: 'appearance dark light',
    group: 'Appearance',
    render: (env) => (
      <SettingRow label={t('lookFeel.theme.label')} description={t('lookFeel.theme.hint')}>
        <ThemeThumbs value={env.settings.theme === 'light' ? 'light' : 'dark'} onPick={(theme) => void env.patch({ theme })} />
      </SettingRow>
    ),
  },
  languageRow,
  {
    id: 'mode-switch-animation',
    label: 'Mode switch animation',
    hint: SWITCH_HINT,
    keywords: 'animation motion transition individual orchestration domino ink fade reduced motion preview',
    group: 'Appearance',
    render: (env) => <ModeSwitchRow env={env} />,
  },
  {
    id: 'usage-bar',
    label: 'Show usage bar',
    hint: 'How much of its plan each signed-in agent has used, at the bottom of the sidebar.',
    keywords: 'usage limit quota plan percent reset used rate limit bar strip',
    group: 'Appearance',
    render: (env) => (
      <SettingToggle
        label={t('lookFeel.usageBar.label')}
        description={t('lookFeel.usageBar.hint')}
        checked={env.settings.show_usage_bar ?? true}
        onChange={(value) => void env.patch({ show_usage_bar: value })}
      />
    ),
  },
  {
    id: 'usage-login-reads',
    label: 'Read Claude usage with my Claude sign-in',
    hint: 'Asks Anthropic for your Claude usage using your Claude sign-in.',
    keywords: 'usage claude anthropic login token limit percent oauth',
    group: 'Appearance',
    render: (env) => (
      <SettingToggle
        label={t('lookFeel.usageLogin.label')}
        description={t('lookFeel.usageLogin.hint')}
        checked={env.settings.usage_login_reads ?? true}
        onChange={(value) => void env.patch({ usage_login_reads: value })}
      />
    ),
  },
  {
    id: 'individual-window-layout',
    label: 'Window layout in Individual',
    hint: LAYOUT_HINT,
    keywords: 'windows side by side snap grid cascade tile layout individual pop-out arrange',
    group: 'Appearance',
    render: (env) => <WindowLayoutRow env={env} />,
  },
  {
    id: 'simple-mode',
    label: SIMPLE_LABEL,
    hint: SIMPLE_HINT,
    keywords: 'simple plain easy beginner fewer buttons words look non-technical',
    group: 'Appearance',
    labs: { name: 'Simple mode', about: 'Fewer buttons and plain words, for people who do not write code.' },
    render: (env) => (
      <SettingToggle
        label={t('settings.row.simple-mode.label')}
        description={t('settings.row.simple-mode.hint')}
        checked={env.settings.simple_mode ?? false}
        onChange={(value) => void env.patch({ simple_mode: value })}
      />
    ),
  },
  {
    id: 'welcome',
    label: WELCOME_LABEL,
    hint: WELCOME.settingHint,
    keywords: 'welcome first run tour setup onboarding start again',
    group: 'Appearance',
    render: (env) => (
      <SettingRow label={t('overview.welcome.label')} description={WELCOME.settingHint}>
        <Btn onClick={() => void env.patch(reopenPatch())}>{t('overview.welcome.button')}</Btn>
      </SettingRow>
    ),
  },
  {
    id: 'confirm-close',
    label: 'Ask before closing a working agent',
    hint: 'Asks first when you close a pane or quit from the tray while an agent works.',
    keywords: 'confirm quit close pane running',
    group: 'While agents work',
    render: (env) => (
      <SettingToggle
        label={t('lookFeel.confirmClose.label')}
        description={t('lookFeel.confirmClose.hint')}
        checked={env.settings.confirm_close_running_pane ?? true}
        onChange={(value) => void env.patch({ confirm_close_running_pane: value })}
      />
    ),
  },
  {
    id: 'keep-awake',
    label: 'Keep this PC awake while agents work',
    hint: 'Your agents keep going when you lock the PC (Win+L). The screen can still turn off.',
    keywords: 'awake sleep lock locked win+l windows power standby suspend screen display idle keep working',
    group: 'While agents work',
    render: (env) => (
      <SettingToggle
        label={t('lookFeel.keepAwake.label')}
        description={t('lookFeel.keepAwake.hint')}
        checked={env.settings.keep_awake_while_working ?? true}
        onChange={(value) => void env.patch({ keep_awake_while_working: value })}
      />
    ),
  },
  {
    id: 'quiet-hours',
    label: 'Quiet hours',
    hint: 'Pause alerts at night. A high-risk approval still comes through.',
    keywords: 'quiet hours night sleep do not disturb silence mute notifications alerts snooze bell',
    group: 'While agents work',
    render: (env) => <QuietHoursRow onSaved={env.markSaved} />,
  },
  {
    id: 'loop-guard',
    label: 'Warn when an agent seems stuck',
    hint: 'Warns when an agent repeats an error or steps, or works long with nothing new.',
    keywords: 'loop guard stuck warning warnings sensitivity repeats quiet too long global shortcut stop all agents panic',
    group: 'While agents work',
    render: (env) => <LoopGuardSettingsBlock onSaved={env.markSaved} />,
  },
  {
    id: 'package-check',
    label: PACKAGE_CHECK_LABEL,
    hint: PACKAGE_CHECK_NOTE,
    keywords: 'package packages install installs npm pip pypi cargo crates gem gems go registry lookup look-alike lookalike typo squat supply chain age downloads scripts',
    group: 'Safety',
    render: (env) => <PackageCheckRow onSaved={env.markSaved} />,
  },
  {
    id: 'away-minutes',
    label: 'Away digest after',
    hint: 'After this many minutes without keyboard or mouse, shows what agents did. 0 is off.',
    keywords: 'away minutes digest while you were away idle',
    group: 'While agents work',
    render: (env) => (
      <SettingRow label={t('lookFeel.away.label')} description={t('lookFeel.away.hint')}>
        <NumberControl
          aria-label={t('lookFeel.away.aria')}
          min={0}
          max={1440}
          value={env.settings.away_minutes ?? 5}
          normalize={clampAwayMinutes}
          suffix={t('lookFeel.away.min')}
          onCommit={(minutes) => env.patch({ away_minutes: minutes })}
        />
        <span className="st-aside">{awayWords(env.settings.away_minutes ?? 5)}</span>
      </SettingRow>
    ),
  },
  ...budgetRows,
  {
    id: 'discord-alerts',
    label: 'Discord alerts',
    hint: 'Post agent alerts to a Discord channel. Paste a webhook link.',
    keywords: 'discord webhook alerts notify channel post needs you finished failed message chat',
    group: 'Discord alerts',
    render: (env) => <DiscordAlertsBlock onSaved={env.markSaved} />,
  },
  {
    id: 'ask-bar',
    label: 'Ask bar',
    hint: 'Ask a quick question from a small bar anywhere in Windows.',
    keywords: 'ask bar shortcut quick question default agent clipboard attach global',
    group: 'Ask bar',
    labs: { name: 'Ask bar', about: 'A small bar you open from anywhere in Windows to ask an agent a quick question.' },
    render: (env) => <AskBarSettingsBlock onSaved={env.markSaved} />,
  },
  {
    id: 'checkpoints',
    label: 'Checkpoints',
    hint: "Saves your files at each agent turn, so you can undo one in History. Needs Git.",
    keywords: 'undo history turn restore git',
    group: 'Undo and memory',
    render: (env) => (
      <SettingToggle
        label={t('settings.row.checkpoints.label')}
        description={t('settings.row.checkpoints.hint')}
        checked={env.settings.checkpoints_enabled ?? true}
        onChange={(value) => void env.patch({ checkpoints_enabled: value })}
      />
    ),
  },
  {
    id: 'checkpoints-keep',
    label: 'Keep last N checkpoints',
    hint: 'Per agent. Older checkpoints are deleted.',
    keywords: 'checkpoints prune',
    group: 'Undo and memory',
    render: (env) => (
      <SettingRow label={t('settings.row.checkpoints-keep.label')} description={t('settings.row.checkpoints-keep.hint')}>
        <NumberControl
          aria-label={t('settings.row.checkpoints-keep.label')}
          min={5}
          max={500}
          step={5}
          disabled={env.settings.checkpoints_enabled === false}
          value={env.settings.checkpoints_keep ?? 50}
          normalize={clampCheckpointsKeep}
          onCommit={(keep) => env.patch({ checkpoints_keep: keep })}
        />
      </SettingRow>
    ),
  },
  {
    id: 'shared-memory',
    label: 'Shared project memory',
    hint: 'Every agent in a project reads one memory file. Off removes it from agent files.',
    keywords: 'memory claude.md agents.md potato-workspace memory.md file',
    group: 'Undo and memory',
    render: (env) => <SharedMemoryToggle onSaved={env.markSaved} />,
  },
  {
    id: 'storage',
    label: 'Task and activity data',
    hint: 'Tasks, file locks and what happened in each pane are kept per project.',
    keywords: 'coordination storage tasks locks events pane events log directory folder refresh',
    group: 'Storage',
    render: (env) => <StorageInfo env={env} />,
  },
  {
    id: 'chat-search-index',
    label: 'Search index of my chats',
    hint: 'Keeps chat text for chat search, on this computer only. Clear it any time.',
    keywords: 'keep keeps clear search index chats find ctrl shift f palette history privacy forget saved text',
    group: 'Storage',
    render: (env) => <ChatIndexSettings env={env} />,
  },
  {
    id: 'bring-old-chats',
    label: 'Bring my chats',
    hint: 'Adds chats from Claude, Codex and other agents to chat search. Stays on this PC.',
    keywords: 'import chats history bring old previous',
    group: 'Storage',
    render: (env) => <BringChatsSettings env={env} />,
  },
  {
    id: 'missions',
    label: 'Missions',
    hint: 'Give agents a goal and checks. They work until the checks pass.',
    keywords: 'mission missions labs preview goal checks loop until tests pass backup agents',
    group: 'Labs',
    labs: { name: 'Missions', about: 'Give agents a goal and checks to work toward.' },
    render: (env) => (
      <LabsSwitch
        label={t('settings.row.missions.label')}
        description={t('settings.row.missions.hint')}
        checked={env.settings.missions_enabled ?? false}
        onChange={(value) => void env.patch({ missions_enabled: value })}
      />
    ),
  },
  {
    id: 'assign-issue',
    label: 'Assign an issue',
    hint: 'Label a GitHub issue and an agent works on it here.',
    keywords: 'github issue label puppet draft pull request',
    group: 'Labs',
    labs: { name: 'Assign an issue', about: 'Start an agent on a GitHub issue when someone on your list labels it.' },
    render: (env) => <AssignIssueSettings onSaved={env.markSaved} projectPath={env.projectPath} />,
  },
  {
    id: 'night-shift',
    label: 'Night Shift',
    hint: 'Agents work overnight in copies. You keep or drop each one.',
    keywords: 'night shift tonight overnight morning sleep labs tasks backup agents',
    group: 'Labs',
    labs: { name: 'Night Shift', about: 'Agents work overnight in copies you keep or drop.' },
    render: (env) => (
      <LabsSwitch
        label={t('settings.row.night-shift.label')}
        description={t('settings.row.night-shift.hint')}
        checked={env.settings.night_shift_enabled ?? false}
        onChange={(value) => void env.patch({ night_shift_enabled: value })}
      />
    ),
  },
  {
    id: 'red-to-green',
    label: 'Red to Green',
    hint: 'When a check fails on a pull request, the same agent can fix it.',
    keywords: 'ci github checks failed fix pull request',
    group: 'Labs',
    labs: { name: 'Red to Green', about: 'When a check fails on a pull request, the same agent can fix it.' },
    render: (env) => <CiFixSettings onSaved={env.markSaved} />,
  },
  {
    id: 'acp-chat-labs',
    label: 'Chat view',
    hint: 'Use an agent as a chat instead of a terminal.',
    keywords: 'chat acp agent client protocol conversation terminal lane labs early',
    group: 'Labs',
    labs: { name: 'Chat view', about: 'Use an agent as a chat instead of a terminal.' },
    render: (env) => (
      <SettingToggle
        label={t('settings.row.acp-chat-labs.label')}
        description={t('settings.row.acp-chat-labs.hint')}
        checked={env.settings.acp_chat_enabled ?? true}
        onChange={(value) => void env.patch({ acp_chat_enabled: value })}
      />
    ),
  },
  {
    id: 'model-bridge-labs',
    label: 'Another model in Codex',
    hint: 'Adds a way to use another model service inside Codex.',
    keywords: 'model bridge service key codex provider responses connect labs early',
    group: 'Labs',
    labs: { name: 'Another model in Codex', about: 'Adds a way to use another model service inside Codex.' },
    render: (env) => (
      <SettingToggle
        label={t('settings.row.model-bridge-labs.label')}
        description={t('settings.row.model-bridge-labs.hint')}
        checked={env.settings.model_bridge_enabled ?? false}
        onChange={(value) => void env.patch({ model_bridge_enabled: value })}
      />
    ),
  },
  {
    id: 'spaces-labs',
    label: 'Spaces',
    hint: 'Chat with friends in small groups, PC to PC. No server keeps messages.',
    keywords: 'spaces chat friends groups small group computer to computer labs early',
    group: 'Labs',
    labs: { name: 'Spaces', about: 'Chat with friends in small groups, PC to PC.' },
    render: (env) => (
      <SettingToggle
        label={t('settings.row.spaces-labs.label')}
        description={t('settings.row.spaces-labs.hint')}
        checked={env.settings.spaces_enabled ?? false}
        onChange={(value) => void env.patch({ spaces_enabled: value })}
      />
    ),
  },
  {
    id: 'lend-labs',
    label: 'Lend an agent',
    hint: 'Lend a sign-in to another PC, or borrow one. Adds a card to Connect.',
    keywords: 'lend borrow share agent usage sign-in login labs early request',
    group: 'Labs',
    labs: { name: 'Lend an agent', about: 'Lend a sign-in to another PC, or borrow one.' },
    render: (env) => (
      <SettingToggle
        label={t('settings.row.lend-labs.label')}
        description={t('settings.row.lend-labs.hint')}
        checked={env.settings.lend_enabled ?? false}
        onChange={(value) => void env.patch({ lend_enabled: value })}
      />
    ),
  },
  {
    id: 'desktop-potato-labs',
    label: 'Desktop Potato',
    hint: 'A small Potato on your desktop. It sleeps, and waves when an agent needs you.',
    keywords: 'desktop potato pet companion mascot always on top bubble labs early',
    group: 'Labs',
    labs: { name: 'Desktop Potato', about: 'A small Potato on your desktop that waves when an agent needs you.' },
    render: (env) => (
      <SettingToggle
        label={t('settings.row.desktop-potato-labs.label')}
        description={t('settings.row.desktop-potato-labs.hint')}
        checked={env.settings.desktop_pet_enabled ?? false}
        onChange={(value) => void env.patch({ desktop_pet_enabled: value })}
      />
    ),
  },
  { id: 'live-room', label: 'Live Room', hint: 'Let people with a link watch a chat. Pick the relay address, how long and how many.', keywords: 'live room share stream watch link relay viewers broadcast default length', group: 'Live Room', render: (env) => <LiveRoomRow onSaved={env.markSaved} /> },
  { id: 'version', label: 'Version', hint: 'Check for updates and download the installer.', keywords: 'app version update release download install', group: 'About', render: () => <VersionRow /> },
  {
    id: 'early-versions',
    label: 'Get early versions (beta)',
    hint: 'Try new versions before everyone else. They may have bugs. Turn off to stay on stable.',
    keywords: 'beta early preview prerelease pre-release channel update updates test new versions',
    group: 'About',
    render: (env) => (
      <SettingToggle
        label={t('settings.row.early-versions.label')}
        description={t('settings.row.early-versions.hint')}
        checked={env.settings.early_versions_enabled ?? false}
        onChange={(value) => void env.patch({ early_versions_enabled: value })}
      />
    ),
  },
  { id: 'whats-new', label: WHATS_NEW_LABEL, hint: 'The short version of what changed, with a link to each place.', keywords: 'release notes changelog new features changes version update 0.2.0', group: 'About', render: (env) => <WhatsNew env={env} /> },
  { id: 'settings-recovery', label: RECOVERY_LABEL, hint: RECOVERY_HINT, keywords: 'restore recover backup damaged broken lost reset settings copy last good', group: 'About', render: (env) => <SettingsRecoveryRow onSaved={env.markSaved} /> },
  { id: 'settings-file', label: 'Settings file', hint: 'Where your settings are saved. Export a copy with keys removed.', keywords: 'export json backup path', group: 'About', render: (env) => <SettingsFile env={env} /> },
  {
    id: 'diagnostic-file',
    label: 'Save a diagnostic file',
    hint: 'A zip of settings (no keys), recent messages and failed runs. Nothing is sent anywhere.',
    keywords: 'diagnostic bug report support logs recording flight zip help speed on this pc slow fast start time closed unexpectedly last crash',
    group: 'About',
    render: (env) => <DiagnosticFile onSaved={env.markSaved} />,
  },
  {
    id: 'show-developer-settings',
    label: 'Show developer settings',
    hint: 'Shows the bridge, MCP, storage and file rows meant for developers.',
    keywords: 'developer dev advanced bridge mcp runtime snippets storage settings file diagnostic',
    group: 'Developer',
    render: (env) => (
      <SettingToggle
        label={t('settings.row.show-developer-settings.label')}
        description={t('settings.row.show-developer-settings.hint')}
        checked={env.settings.show_developer_settings ?? false}
        onChange={(value) => void env.patch({ show_developer_settings: value })}
      />
    ),
  },
  { id: 'uninstall', label: 'Uninstall Potato Workspace', hint: 'Remove the app from this computer.', keywords: 'remove delete', danger: true, render: (env) => <UninstallRow env={env} /> },
];
