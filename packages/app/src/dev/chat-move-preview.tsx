import { MovedNote } from '../components/chat/ChatMove';
import { MoveSheet } from '../components/chat/MoveSheet';
import { ChatComposer } from '../components/chat/ChatComposer';
import { SessionChatView } from '../components/chat/SessionChatView';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';
import type { MoveApi } from '../lib/moveChat';
import { DevicesFake, MAC_MINI, WORK_LAPTOP } from './devices-fixtures';

// "Move to…" (see components/chat/MoveSheet.tsx and ChatMove.tsx), drawn over the cockpit: the sheet with a device picked, and a
// chat that moved (the note and the box that is off).
const T0 = Date.UTC(2026, 10, 15, 1, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: at(0), text: 'Build the .dmg for the app' },
  { kind: 'assistant', id: 'a1', at: at(2), text: 'I will run the build on the Mac. The script is ready.', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: at(3), outcome: 'completed', durationMs: 41_000 },
];

const api: MoveApi = {
  status: async () => ({ state: 'none' }),
  begin: async () => ({ agentType: 'claude', agentLabel: 'Claude' }),
  history: async () => ({ text: '' }),
  prepareWork: async () => ({ branch: 'potato/move-abc123def0', sha: '', bundleB64: '', size: 0 }),
  finish: async () => undefined,
  abort: async () => undefined,
  onChanged: async () => () => undefined,
};

const shell = { position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 } as const;

export function MoveSheetPreview() {
  const fake = new DevicesFake({ enabled: true, name: 'Desk-PC', devices: [{ ...MAC_MINI, lets_run: true }, WORK_LAPTOP] });
  return (
    <div className="cockpit" style={shell}>
      <MoveSheet paneId="p1" agentType="claude" agentLabel="Claude" running={false} isChat view={fake.view} api={api} devices={fake} onClose={() => undefined} onMoved={() => undefined} />
    </div>
  );
}

export function MovedPreview() {
  const status = { state: 'moved' as const, node: MAC_MINI.node, device: 'Mac mini', far_pane: 'n1', at: Math.floor(new Date(2026, 10, 15, 14, 20).getTime() / 1000), mode: 'history' as const };
  return (
    <div className="cockpit" style={shell}>
      <div style={{ width: 700, height: 560, margin: '0 auto', border: '1px solid var(--sep)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <SessionChatView
          state="ready"
          reason={null}
          source="acp"
          turns={groupTurns(ITEMS).turns}
          model="Claude"
          cliVersion={null}
          paneId="preview-moved"
          banner={<MovedNote status={status} />}
          composer={<ChatComposer onSend={async () => null} blockedReason="This chat moved to Mac mini. Open it there to carry on." />}
        />
      </div>
    </div>
  );
}
