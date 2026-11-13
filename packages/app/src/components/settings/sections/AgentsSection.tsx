// Settings > Agents: signing in, keeping agents warm (preload) and agent definitions (TOML files,
// consent, review and approval). Most blocks save through their own command; the Live updates row calls env.patch.
import { SIGN_IN } from '../../../lib/glossary';
import { requestAddAgentAction } from '../../../lib/addAgentActions';
import { openSettingsAt } from '../../../lib/openSettingsAt';
import { AccountsGroup } from '../accounts/AccountsGroup';
import { AgentsView } from '../agents/AgentsView';
import { AddAgent } from '../blocks/AddAgent';
import { AgentDefinitions } from '../blocks/AgentDefinitions';
import { AGENT_MODELS_HINT, AGENT_MODELS_LABEL, AgentDefaultModels } from '../blocks/AgentDefaultModels';
import { AgentLaneRows } from '../blocks/AgentLaneRows';
import { AgentVersions } from '../blocks/AgentVersions';
import { CHAT_ADDONS_LABEL, ChatAddonRows } from '../blocks/ChatAddonRows';
import { COLLISION_LABEL, CollisionSettings } from '../blocks/CollisionSettings';
import { CloseHelpersWithAgentToggle, HelperAgentsChoice, KeepHelpersOpenToggle, MostHelpersAtOnce } from '../blocks/HelperAgents';
import { HELPER_MODELS_HINT, HELPER_MODELS_LABEL, HelperDefaultModels } from '../blocks/HelperModels';
import { HiddenAgentsRow } from '../blocks/HiddenAgentsRow';
import { PreloadSettings } from '../blocks/PreloadSettings';
import { HANDOFF_MODE_HINT, HANDOFF_MODE_LABEL, QuickHandoffRows } from '../blocks/QuickHandoffRows';
import { useEffect, useState } from 'react';
import { t, useT } from '../../../i18n';
import { agentHealthApi, type AgentHealth } from '../../../lib/agent-health';
import { DEV_LABS_KEYS } from '../../../lib/dev-labs';
import { SETUP_CHECK_ROW_ID } from '../../../lib/openSettingsAt';
import { SetupCheckPage } from '../SetupCheckPage';
import { Popup } from '../controls';
import type { RowDef, SettingsEnv } from '../model';
import { requestBringChats } from '../../../lib/chatImport';
import { Btn, SettingRow, SettingToggle } from '../settings-ui';
import { KeepGoingRows } from './KeepGoingRows';
import { LinuxRows } from './LinuxRows';

type HookMode = 'off' | 'shadow' | 'evidence';

/** Agents whose live updates are off until the user turns them on (the backend says which). */
function useOptInAgents(): AgentHealth[] {
  const [rows, setRows] = useState<AgentHealth[]>([]);
  useEffect(() => {
    let alive = true;
    agentHealthApi
      .check()
      .then((all) => alive && setRows(all.filter((r) => r.installed && r.hooks?.opt_in)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return rows;
}

function LiveUpdates({ env }: { env: SettingsEnv }) {
  const t = useT();
  // 'evidence' is a later step that has no control yet; it reads as watch only here.
  const value = env.settings.agent_hooks_mode === 'off' ? 'off' : 'shadow';
  const optIn = useOptInAgents();
  const chosen = env.settings.agent_hooks_agents ?? {};
  const isOn = (r: AgentHealth) => (chosen[r.id] ? chosen[r.id] !== 'off' : Boolean(r.hooks?.enabled));
  const setAgent = (id: string, on: boolean) => {
    const next: Record<string, HookMode> = { ...chosen, [id]: on ? 'shadow' : 'off' };
    void env.patch({ agent_hooks_agents: next });
  };
  return (
    <>
      <SettingRow
        label={t('settings.row.live-updates.label')}
        description={t('liveUpdates.help')}
      >
        <Popup
          aria-label={t('settings.row.live-updates.label')}
          value={value}
          onChange={(event) => void env.patch({ agent_hooks_mode: event.target.value as 'off' | 'shadow' })}
        >
          <option value="shadow">{t('liveUpdates.watchOnly')}</option>
          <option value="off">{t('telegram.off')}</option>
        </Popup>
      </SettingRow>
      {optIn.map((r) => (
        <SettingToggle
          key={r.id}
          label={t('liveUpdates.from', { agent: r.label })}
          description={r.hooks?.opt_in_note ?? undefined}
          checked={value !== 'off' && isOn(r)}
          disabled={value === 'off'}
          onChange={(on) => setAgent(r.id, on)}
        />
      ))}
    </>
  );
}

/** "Check my setup": one list of what works and one fix per problem. Its id is SETUP_CHECK_ROW_ID (Repair install opens it). */
export const setupCheckRow: RowDef = {
  id: SETUP_CHECK_ROW_ID,
  label: 'Check my setup',
  hint: 'What is running, which agents are signed in, and what needs one fix.',
  keywords: 'check setup health repair install bridge sign in agent deepseek key computer add-on labs copy report',
  group: 'Check my setup',
  render: (env) => (
    <SetupCheckPage
      ctx={{ bridgeUrl: env.bridgeUrl, labs: Object.fromEntries(DEV_LABS_KEYS.map((k) => [k, env.settings[k]])) }}
    />
  ),
};

export const agentsRows: RowDef[] = [
  {
    id: 'add-agent',
    level: 'basic',
    label: 'Add an agent',
    hint: "Type an agent's name. Potato finds it, checks it and adds it.",
    keywords: 'add new agent install name kimi paste command find advanced wizard import terminal chat',
    group: 'Add an agent',
    render: (env) => (
      <AddAgent
        projectDir={env.projectPath}
        onStartChat={(id) => requestAddAgentAction('chat', id)}
        onOpenTerminal={(id) => requestAddAgentAction('terminal', id)}
        onOpenAgent={(id) => requestAddAgentAction('terminal', id)}
        onShowInstall={() => openSettingsAt('agents', 'chat-addons')}
        onOpenLabs={() => openSettingsAt('general', 'labs-index')}
      />
    ),
  },
  {
    id: 'agent-list',
    level: 'basic',
    label: 'Your agents',
    hint: 'One page per agent: sign-ins, model, how it opens, version and what it can do.',
    keywords: 'agents list page claude codex each agent sign in model chat terminal version remove chips capabilities what it can do',
    group: 'Your agents',
    // Found on this computer: the Add an agent box above holds it (built there, not here).
    render: (env) => <AgentsView env={env} />,
  },
  setupCheckRow,
  {
    id: 'accounts',
    label: SIGN_IN.rowLabel,
    hint: SIGN_IN.rowHint,
    keywords: SIGN_IN.rowKeywords,
    group: SIGN_IN.group,
    render: () => <AccountsGroup />,
  },
  {
    id: 'bring-chats-agents',
    label: 'Bring my chats',
    hint: 'Pick an agent, see its newest chats and bring them into your chat list.',
    keywords: 'bring import old previous chats history agents list',
    group: 'Your chats',
    render: () => (
      <SettingRow label={t('agentsRows.bringLabel')} description={t('agentsRows.bringHelp')}>
        <Btn onClick={() => requestBringChats()}>{t('agentsRows.bringBtn')}</Btn>
      </SettingRow>
    ),
  },
  {
    id: 'preload',
    label: 'Keep agents ready',
    hint: 'Keep an agent started and waiting, so opening a pane feels instant.',
    keywords: 'preload warm standby idle timeout status agents to keep warm',
    group: 'Speed',
    render: (env) => <PreloadSettings onSaved={env.markSaved} />,
  },
  {
    id: 'agent-default-models',
    label: AGENT_MODELS_LABEL,
    hint: AGENT_MODELS_HINT,
    keywords: 'default model models agent agents start starting choose pick which gpt sonnet opus haiku opencode terminal chat',
    group: 'Models',
    render: (env) => <AgentDefaultModels saved={env.settings.agent_default_models} onChange={(next) => void env.patch({ agent_default_models: next })} />,
  },
  {
    id: 'helper-tools',
    label: 'Potato Workspace helpers inside agents',
    hint: 'Give every agent you open here the Potato Workspace helper tools, ready with no setup.',
    keywords: 'mcp helpers helper tools run agent wait agents subagent spawn inside pane panes automatic setup bridge claude codex opencode',
    group: 'Helpers',
    render: (env) => (
      <SettingToggle
        label={t('agentsRows.helperToolsLabel')}
        description={t('agentsRows.helperToolsHelp')}
        checked={env.settings.pane_mcp_enabled ?? true}
        onChange={(value) => void env.patch({ pane_mcp_enabled: value })}
      />
    ),
  },
  {
    id: 'helper-agents',
    label: 'Helper agents',
    hint: 'Choose whether helpers an agent starts are shown in a pane or run in the background.',
    keywords: 'hidden helper helpers headless background invisible no window pane subagent sub-agent agent hide show visible watch inbox always show choose',
    group: 'Helpers',
    render: (env) => <HelperAgentsChoice onSaved={env.markSaved} />,
  },
  {
    id: 'helper-default-models',
    label: HELPER_MODELS_LABEL,
    hint: HELPER_MODELS_HINT,
    keywords: 'helper helpers model default models subagent sub-agent agent choose pick gpt sonnet opus haiku opencode which',
    group: 'Helpers',
    render: (env) => <HelperDefaultModels saved={env.settings.helper_default_models} onChange={(next) => void env.patch({ helper_default_models: next })} />,
  },
  {
    id: 'keep-helpers-open',
    label: 'Keep helpers open when they finish',
    hint: 'On: a finished helper stays open so you can read it and ask it more.',
    keywords: 'keep open close closed pane finish finished done helper helpers subagent sub-agent follow-up followup release',
    group: 'Helpers',
    render: (env) => <KeepHelpersOpenToggle onSaved={env.markSaved} />,
  },
  {
    id: 'close-helpers-with-agent',
    label: 'Close helpers when their agent closes',
    hint: 'On: when you close an agent, the helpers it started close too.',
    keywords: 'close closed closing helper helpers subagent sub-agent parent orchestrator agent pane leftover orphan stop with together',
    group: 'Helpers',
    render: (env) => <CloseHelpersWithAgentToggle onSaved={env.markSaved} />,
  },
  {
    id: 'most-helpers-at-once',
    label: 'Most helpers at once',
    hint: 'How many helpers run together when one call starts several.',
    keywords: 'most helpers at once how many parallel batch limit cap queue several many same time subagents',
    group: 'Helpers',
    render: (env) => <MostHelpersAtOnce onSaved={env.markSaved} />,
  },
  {
    id: 'handoff-mode',
    label: HANDOFF_MODE_LABEL,
    hint: HANDOFF_MODE_HINT,
    keywords: 'handoff hand off every quick handoff handoff to new agent fresh ready new agent same agent note notes fixed always remember continue switch temporary file HANDOFF.md save',
    group: 'Handoff',
    render: (env) => <QuickHandoffRows env={env} />,
  },
  {
    id: 'hidden-agents',
    label: 'Agents in the New agent menu',
    hint: 'Hide the agents you never use from the New agent menu.',
    keywords: 'hide show hidden agent agents new agent menu list edit remove visible tick untick plus button',
    group: 'Menu',
    render: () => <HiddenAgentsRow />,
  },
  {
    id: 'versions',
    label: 'Agent versions',
    hint: 'Check that an agent still starts the way Potato Workspace expects after it updates.',
    keywords: 'version update tested untested check canary strict unknown screens recognise capture folder fixture',
    group: 'Updates',
    render: () => <AgentVersions />,
  },
  {
    id: 'show-terminals',
    label: 'Show terminals',
    hint: 'Off: agents start as a chat. Terminals already open keep working.',
    keywords: 'terminal terminals show hide chat only console shell lane command line',
    group: 'Chat',
    render: (env) => (
      <SettingToggle
        label={t('settings.row.show-terminals.label')}
        description={t('settings.row.show-terminals.hint')}
        checked={env.settings.show_terminals ?? false}
        onChange={(value) => void env.patch({ show_terminals: value })}
      />
    ),
  },
  {
    id: 'agent-lane',
    label: 'How to run',
    hint: 'Helpers run as a chat when the agent can, else in a terminal.',
    keywords: 'chat acp terminal lane run mode conversation session how to run',
    group: 'Chat',
    labsFlag: 'acp_chat_enabled',
    render: () => <AgentLaneRows />,
  },
  {
    id: 'chat-addons',
    label: CHAT_ADDONS_LABEL,
    hint: 'The small helper each agent needs to run as a chat. Install or remove it here.',
    keywords: 'chat acp add-on addon adapter install remove helper download sign in claude codex',
    group: 'Chat',
    labsFlag: 'acp_chat_enabled',
    render: () => <ChatAddonRows />,
  },
  {
    id: 'live-updates',
    label: 'Live updates',
    hint: 'Claude and Codex tell Potato Workspace when they start, ask and finish.',
    keywords: 'hooks hook lane live updates claude codex watch report trust',
    group: 'Live updates',
    labs: { name: 'Live updates', about: 'Claude and Codex report when they start, ask and finish.' },
    render: (env) => <LiveUpdates env={env} />,
  },
  {
    id: 'keep-going',
    label: 'When an agent runs out of usage',
    hint: 'Pick the agents a task can move to when the agent it runs on runs out of usage.',
    keywords: 'keep going continue move another agent limit usage run out reset back first resets offer order fallback backup hand over ask runs',
    group: 'Keep going',
    render: (env) => <KeepGoingRows onSaved={env.markSaved} />,
  },
  {
    id: 'linux',
    label: 'Run agents in Linux (WSL)',
    hint: 'Run an agent inside WSL, in a folder on a Windows drive, instead of on Windows.',
    keywords: 'linux wsl ubuntu distro subsystem runs on place check windows drive inside',
    group: 'Linux',
    render: (env) => <LinuxRows onSaved={env.markSaved} />,
  },
  {
    id: 'collision',
    label: COLLISION_LABEL,
    hint: 'Warns when two agents change the same file. It never pauses or stops an agent.',
    keywords: 'collision clash conflict same file two agents overlap warn warning changed lines copies folder alert',
    group: 'Same file',
    render: (env) => <CollisionSettings onSaved={env.markSaved} />,
  },
  {
    id: 'definitions',
    label: 'Agent definitions',
    hint: 'Add your own agents from a small settings file. New ones stay off until you approve.',
    keywords: 'toml consent project sources import export fixtures revoke approve review extra directories generic agent reload',
    render: (env) => <AgentDefinitions onOpenStore={env.openStore} />,
  },
];
