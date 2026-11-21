// The two "Where" bodies that start a pane on this PC's side: a Linux distro (WSL) and an SSH machine. Both only choose
// an agent and a folder; the command layer decides what is allowed and says no in one plain sentence.
import { useEffect, useState, type ReactNode } from 'react';
import { remoteProjectPath, sshLocation } from '../../lib/projectLocation';
import { markRemotePane } from '../../lib/remotePanes';
import { savePlace } from '../../lib/newAgentPlace';
import { addLocatedProject } from '../../lib/sidebarProjects';
import { useT } from '../../i18n';
import { sshAgents, sshApi, type SshApi, type SshHost } from '../../lib/ssh';
import { spawnPaneInLinux, tauriWslApi, wslPlacesGet, type WslApi } from '../../lib/wsl';
import { PlacePanel, type PlaceAgent } from './PlacePanel';

/** An agent starts in the chosen distro, whatever the saved "Runs on" setting says. */
export function WslPanel({ distro, api = tauriWslApi, onStarted, leading }: { distro: string; api?: WslApi; onStarted: (paneId: string) => void; leading?: ReactNode }) {
  const t = useT();
  const [agents, setAgents] = useState<PlaceAgent[] | null>(null);
  useEffect(() => {
    let live = true;
    wslPlacesGet(api).then(
      (rows) => live && setAgents(rows.filter((r) => r.whyNot === null).map((r) => ({ id: r.agentId, label: r.label }))),
      () => live && setAgents([]),
    );
    return () => {
      live = false;
    };
  }, [api, distro]);
  if (agents === null) return <>{leading}</>;
  return (
    <PlacePanel
      testId="wsl-panel"
      leading={leading}
      agents={agents}
      noneText={t('devices.wsl.none')}
      folderLabel={t('devices.wsl.folderLabel')}
      folderPlaceholder={t('devices.wsl.folderPlaceholder')}
      folderHelp={t('devices.wsl.folderHelp')}
      startLabel={t('devices.wsl.start')}
      onStart={(agent, folder) => spawnPaneInLinux({ agent_type: agent, ...(folder ? { cwd: folder } : {}) }, distro, api)}
      onStarted={onStarted}
    />
  );
}

/**
 * An agent on an SSH machine: a CHAT that runs there (when the backend says its agents can), or a terminal there. The chat's folder
 * is saved as a project of the machine (shown with the `ssh (name)` badge in Projects), and the chat opens in the normal chat view.
 */
export function SshPanel({ host, api = sshApi, onStarted, leading, initialFolder }: { host: SshHost; api?: SshApi; onStarted: (paneId: string) => void; leading?: ReactNode; initialFolder?: string }) {
  const t = useT();
  const chatAgents = host.chatAgents ?? [];
  const canChat = chatAgents.length > 0;
  const [chat, setChat] = useState(canChat);
  const chatMode = canChat && chat;
  const toggle = canChat ? (
    <div className="dev-field" key="mode">
      <span>{t('devices.ssh.modeLabel', { name: host.name })}</span>
      <div className="dev-tabs" role="radiogroup" aria-label={t('devices.ssh.modeLabel', { name: host.name })}>
        <button type="button" role="radio" aria-checked={chatMode} className={`dev-tab${chatMode ? ' is-on' : ''}`} data-testid="ssh-mode-chat" onClick={() => setChat(true)}>
          {t('devices.ssh.modeChat')}
        </button>
        <button type="button" role="radio" aria-checked={!chatMode} className={`dev-tab${!chatMode ? ' is-on' : ''}`} data-testid="ssh-mode-terminal" onClick={() => setChat(false)}>
          {t('devices.ssh.modeTerminal')}
        </button>
      </div>
    </div>
  ) : null;
  const startChat = async (agent: string, folder: string | undefined): Promise<string> => {
    if (!folder) throw new Error(t('devices.ssh.chatFolderNeeded', { name: host.name }));
    const paneId = await api.chat(host.id, agent, folder);
    // The pane and the project are noted before the screen opens the pane, so it never shows this machine's folder as a local one.
    markRemotePane(paneId, host.id, host.name);
    // The project is this machine plus this folder: another machine with the same folder is another project.
    const project = remoteProjectPath(host.id, folder);
    addLocatedProject(project, sshLocation(host.id, host.name));
    // The next New agent for this project opens on this machine again, with this folder.
    savePlace(project, `ssh:${host.id}`);
    return paneId;
  };
  return (
    <PlacePanel
      testId="ssh-panel"
      key={chatMode ? 'chat' : 'terminal'}
      leading={
        <>
          {leading}
          {toggle}
        </>
      }
      agents={chatMode ? chatAgents : sshAgents(host)}
      noneText=""
      notes={chatMode ? [t('devices.ssh.chatNote', { name: host.name }), t('devices.ssh.chatKeyNote', { name: host.name })] : [t('devices.ssh.terminalOnly', { name: host.name }), t('devices.ssh.terminalOn', { name: host.name })]}
      folderLabel={t('devices.ssh.folderLabel', { name: host.name })}
      folderPlaceholder={t('devices.ssh.folderPlaceholder')}
      startLabel={chatMode ? t('devices.ssh.chatStart') : t('devices.ssh.start')}
      onStart={chatMode ? startChat : (agent, folder) => api.open(host.id, agent, folder)}
      onStarted={onStarted}
      initialFolder={chatMode ? initialFolder : undefined}
    />
  );
}
