// A chat that runs on another PC, drawn by the normal chat screen: the same conversation view and the same message box as a chat
// on this PC. Only its data is the other PC's (`lib/runtime/remoteChat.ts`, the PC link's transcript read) and its messages
// go through the PC link. The far PC enforces its rights: a PC that lets this one only watch gets "Watch only" in place of the box.
import { useCallback, useMemo } from 'react';
import { useT } from '../../i18n';
import type { PcLinkClient, PcMode } from '../../lib/runtime/pclink';
import { ChipMenu } from '../chat/ChipMenu';
import { pcLinkOutboxTransport } from '../../lib/runtime/pclinkOutbox';
import { useRemoteChat } from '../../lib/runtime/remoteChat';
import { usePaneOutbox } from '../../hooks/usePaneOutbox';
import { usePendingBubbles } from '../../hooks/usePendingBubbles';
import { ChatAnswerContext } from '../chat/chatAnswer';
import { ChatComposer } from '../chat/ChatComposer';
import { PendingMessages } from '../chat/PendingMessages';
import { SessionChatView } from '../chat/SessionChatView';

export interface RemoteMeta {
  agent?: string;
  branch?: string;
  model?: string;
  mode?: PcMode;
}

/** The chat's agent, model and permission mode as small read-only chips, like the local message box's settings (no list, no change). */
function RemoteMetaChips({ meta }: { meta?: RemoteMeta }) {
  const t = useT();
  const chips: { id: string; label: string; value: string; name: string; tone?: 'risk' }[] = [];
  // The agent chip rides along only with something the far PC said about the chat: an older far PC shows nothing extra.
  const said = !!(meta?.model || meta?.mode === 'asks' || meta?.mode === 'acts_without_asking');
  if (said && meta?.agent) chips.push({ id: 'agent', label: t('devices.remote.chipAgent'), value: meta.agent, name: meta.agent });
  if (meta?.model) chips.push({ id: 'model', label: t('pane.chipModel'), value: meta.model, name: meta.model });
  if (meta?.mode === 'asks') chips.push({ id: 'mode', label: t('pane.chipPermissions'), value: 'asks', name: t('devices.remote.modeAsks') });
  if (meta?.mode === 'acts_without_asking') chips.push({ id: 'mode', label: t('pane.chipPermissions'), value: 'acts', name: t('devices.remote.modeActs'), tone: 'risk' });
  if (chips.length === 0) return null;
  return (
    <div className="ck-acp-chips" data-testid="remote-chips">
      <div className="ck-acp-chips-row" role="group" aria-label="Chat settings">
        {chips.map((c) => (
          <ChipMenu key={c.id} chipId={`remote-${c.id}`} label={c.label} hint={`${c.label}: ${c.name}`} value={c.value} choices={[{ value: c.value, name: c.name }]} onChange={() => undefined} readOnly tone={c.tone} />
        ))}
      </div>
    </div>
  );
}

export function RemoteChat({ client, node, paneId, canWatch, canType, running = false, online = true, name = '', headerSlot, canFull = true, meta }: { /** This PC may do everything there (Full). Unknown counts as yes: the far PC enforces it anyway. */ canFull?: boolean; /** What the far PC says about this chat (all absent from an older far PC: nothing extra is drawn). */ meta?: RemoteMeta; /** The empty end of the pane header the view draws its own controls into (as a chat on this PC does). */ headerSlot?: { el: HTMLElement; compact: boolean }; client: PcLinkClient | null; node: string; paneId: string; canWatch: boolean; canType: boolean; running?: boolean; online?: boolean; name?: string }) {
  const t = useT();
  // Everything that keys local state (view mode, drafts, plan progress, workflow cards) gets a key no pane of this PC can have.
  const chatKey = `device:${node}:${paneId}`;
  const { status, grouped, earlier, pictures } = useRemoteChat(client, paneId, canWatch, online, chatKey);
  // A chat that runs a message with no card at all is Full by another name: below Full say so up front instead of after a refused send.
  const needsFull = canWatch && canType && !canFull && meta?.mode === 'acts_without_asking';
  const canSend = canWatch && canType && online && !needsFull;
  const transport = useMemo(() => (client ? pcLinkOutboxTransport(client) : null), [client]);
  const outbox = usePaneOutbox(transport, paneId, canSend, true);
  const userTexts = useMemo(() => grouped.turns.flatMap((turn) => (turn.user ? [turn.user.text] : [])), [grouped.turns]);
  const { bubbles, hide } = usePendingBubbles(outbox.messages, userTexts);
  const onStop = useCallback(() => void client?.interrupt(paneId).catch(() => undefined), [client, paneId]);
  const interrupt = canSend && client ? onStop : undefined;
  const pending = canSend ? <PendingMessages messages={bubbles} onCancel={outbox.cancel} onHold={outbox.hold} onEdit={outbox.edit} onHide={hide} onSendNow={interrupt} onRetry={outbox.send} onStartFresh={interrupt} /> : undefined;
  const chips = <RemoteMetaChips meta={meta} />;
  const composer = canSend ? (
    <ChatComposer onSend={outbox.send} blockedReason={null} draftKey={chatKey} running={running} onStop={interrupt} history={userTexts} toolbar={chips} footnote={meta?.branch ? <>{t('devices.remote.landsOn')} <span className="ck-chat-where-branch">{meta.branch}</span></> : undefined} />
  ) : needsFull ? (
    <>
      {chips}
      <p className="dev-watch-only" data-testid="remote-needs-full">
        {t('devices.remote.needsFull', { name })}
      </p>
    </>
  ) : canWatch && canType ? undefined : (
    <>
      {chips}
      <p className="dev-watch-only" data-testid="remote-watch-only">
        {t('devices.watchOnlyBox', { name })}
      </p>
    </>
  );
  return (
    <div className="dev-remote-chat" data-testid="remote-chat">
      <ChatAnswerContext.Provider value={canSend ? outbox.send : null}>
        <SessionChatView
          state={status.state}
          reason={status.reason}
          waitingFor={status.waitingFor}
          source={status.source}
          turns={grouped.turns}
          model={grouped.model}
          cliVersion={null}
          paneId={chatKey}
          earlier={earlier}
          pictures={pictures}
          pending={pending}
          composer={composer}
          readOnly={!canSend}
          headerSlot={headerSlot}
          hideViewMode
        />
      </ChatAnswerContext.Provider>
    </div>
  );
}
