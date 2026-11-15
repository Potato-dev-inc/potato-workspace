// "Move to…" for one chat: the hook the pane view uses (the status of the chat's move, the menu entry, the sheet) and the
// note under a chat that moved. A chat that is moving has its message box off; a chat that moved is read-only and says
// where it went, with "Open it there".
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { devicesApi, useDevicesEnabled, type DevicesApi } from '../../lib/devices';
import { moveBlock, movedLine, requestOpenRemote, tauriMoveApi, type MoveApi, type MoveStatus } from '../../lib/moveChat';
import { useDevices } from '../devices/useDevices';
import { MoveSheet } from './MoveSheet';
import '../../styles/chat-move.css';

const NONE: MoveStatus = { state: 'none' };

export interface ChatMove {
  /** `Move to…` in the chat menu: absent when Devices is off or the chat already moved. */
  onMove?: () => void;
  /** Why the message box is off because of a move, or null. */
  blockedReason: string | null;
  /** Drawn under the chat's banners: the "Moved to…" note. */
  note: ReactNode;
  /** The sheet, while it is open. */
  sheet: ReactNode;
}

export function useChatMove(
  paneId: string,
  chat: { agentType: string; agentLabel: string; running: boolean; isChat: boolean },
  api: MoveApi = tauriMoveApi,
  devices: DevicesApi = devicesApi,
): ChatMove {
  const enabled = useDevicesEnabled();
  const [status, setStatus] = useState<MoveStatus>(NONE);
  const [open, setOpen] = useState(false);

  const read = useCallback(() => {
    api.status(paneId).then(
      (s) => setStatus(s && typeof s === 'object' && 'state' in s ? s : NONE),
      () => setStatus(NONE),
    );
  }, [api, paneId]);

  useEffect(() => {
    read();
    let stop: (() => void) | null = null;
    let gone = false;
    void api.onChanged((id) => id === paneId && read()).then((un) => (gone ? un() : (stop = un)));
    return () => {
      gone = true;
      stop?.();
    };
  }, [api, paneId, read]);

  const moved = status.state === 'moved';
  return {
    onMove: enabled && !moved ? () => setOpen(true) : undefined,
    blockedReason: moveBlock(status),
    note: status.state === 'moved' ? <MovedNote status={status} /> : null,
    sheet: open ? (
      <MoveHost
        paneId={paneId}
        chat={chat}
        api={api}
        devices={devices}
        onClose={() => {
          setOpen(false);
          read();
        }}
      />
    ) : null,
  };
}

function MoveHost({ paneId, chat, api, devices, onClose }: { paneId: string; chat: { agentType: string; agentLabel: string; running: boolean; isChat: boolean }; api: MoveApi; devices: DevicesApi; onClose: () => void }) {
  const { view } = useDevices(devices);
  return (
    <MoveSheet
      paneId={paneId}
      agentType={chat.agentType}
      agentLabel={chat.agentLabel}
      running={chat.running}
      isChat={chat.isChat}
      view={view}
      api={api}
      devices={devices}
      onClose={onClose}
      onMoved={(node, farPane) => {
        onClose();
        requestOpenRemote(node, farPane);
      }}
    />
  );
}

export function MovedNote({ status }: { status: Extract<MoveStatus, { state: 'moved' }> }) {
  const t = useT();
  return (
    <div className="ck-moved-note" role="status" data-testid="moved-note">
      <span className="ck-moved-note-text">{movedLine(status)}</span>
      <button type="button" className="ck-btn ck-btn--sm" onClick={() => requestOpenRemote(status.node, status.far_pane)} data-testid="moved-open">
        {t('move.openThere')}
      </button>
    </div>
  );
}
