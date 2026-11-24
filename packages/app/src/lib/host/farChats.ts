// The chats of the other PCs as the Ctrl+K palette lists them: one row per chat the sidebar shows (a standby's own chat and a minion are not
// listed there, so not here). Names come from the owning PC; texts come from the far PC and are drawn as text only.
import type { RemoteRow } from '../../components/devices/useDeviceGroups';
import { farChatName } from './farCockpit';

export interface FarChatRow {
  key: string;
  /** The chat's title there, else its agent's name numbered as its own PC numbers it. */
  title: string;
  agent: string;
  agentLabel: string;
  device: string;
  folder: string;
  status: RemoteRow['status'];
}

export function farChatRows(groups: ReadonlyArray<{ device: { name: string; state: string }; rows: readonly RemoteRow[] }>, label: (agent: string) => string): FarChatRow[] {
  return groups
    .filter((g) => g.device.state === 'online')
    .flatMap((g) =>
      g.rows
        .filter((r) => r.chat && !r.standby && r.startedAs !== 'minion')
        .map((r) => {
          const agentLabel = label(r.agent);
          return { key: r.key, title: r.title || (farChatName(agentLabel, r) ?? agentLabel), agent: r.agent, agentLabel, device: g.device.name, folder: r.cwd, status: r.status };
        }),
    );
}
