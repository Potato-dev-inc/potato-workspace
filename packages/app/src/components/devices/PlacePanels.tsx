// The two "Where" bodies that start a pane on this PC's side: a Linux distro (WSL) and an SSH machine. Both only choose
// an agent and a folder; the command layer decides what is allowed and says no in one plain sentence.
import { useEffect, useState, type ReactNode } from 'react';
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

/** A terminal on an SSH machine: a shell, or one of the CLI agents its last check found. Never a chat. */
export function SshPanel({ host, api = sshApi, onStarted, leading }: { host: SshHost; api?: SshApi; onStarted: (paneId: string) => void; leading?: ReactNode }) {
  const t = useT();
  return (
    <PlacePanel
      testId="ssh-panel"
      leading={leading}
      agents={sshAgents(host)}
      noneText=""
      notes={[t('devices.ssh.terminalOnly', { name: host.name }), t('devices.ssh.terminalOn', { name: host.name })]}
      folderLabel={t('devices.ssh.folderLabel', { name: host.name })}
      folderPlaceholder={t('devices.ssh.folderPlaceholder')}
      startLabel={t('devices.ssh.start')}
      onStart={(agent, folder) => api.open(host.id, agent, folder)}
      onStarted={onStarted}
    />
  );
}
