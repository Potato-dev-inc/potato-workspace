// "Where" in New agent: a pill (This PC, or a paired device) over the usual New agent body. While a device is picked, the body
// is that device's own: its installed agents and its recent projects (the far bridge's `GET /phone/new-chat`), and starting
// goes through the far bridge. A device that is offline, or does not let this PC in, is listed but cannot be picked.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { devicesApi, runtimesOf, stateSentence, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { PhoneNewChat } from '../mobile/PhoneNewChat';
import '../../styles/devices.css';

export interface WhereProps {
  view: DevicesView | null;
  /** "Add a device…": opens Settings > Devices. */
  onAddDevice: () => void;
  /** Something was started on a device: open it. `chat` is false for a terminal. */
  onStarted: (device: Device, paneId: string, chat: boolean) => void;
  api?: DevicesApi;
}

export function NewAgentWhere({ where, children }: { where?: WhereProps; children: ReactNode }) {
  const t = useT();
  const api = where?.api ?? devicesApi;
  const [pickedNode, setPickedNode] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const runtimes = useMemo(() => runtimesOf(where?.view ?? null), [where?.view]);
  const picked = where?.view?.devices.find((d) => d.node === pickedNode) ?? null;
  const bridge = useMemo(() => (picked ? makeRemoteClient(picked.node, api) : null), [picked?.node, api]);
  // A closed menu and a click elsewhere end the picker; a device that went away ends the pick.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => {
    if (pickedNode && !picked) setPickedNode(null);
  }, [pickedNode, picked]);
  if (!where?.view?.enabled) return <>{children}</>;
  const here = picked ? picked.name : t('devices.thisPc');
  return (
    <>
      <div className="dev-where" ref={wrap} data-testid="where">
        <span>{t('devices.where')}</span>
        <button type="button" className="dev-where-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="where-pill">
          {here} ▾
        </button>
        {open && (
          <div className="dev-where-menu" role="menu" aria-label={t('devices.pickWhere')}>
            {runtimes.map((r) => {
              if (r.kind === 'wsl') return null;
              const pickable = r.kind === 'this' || r.pickable;
              const on = r.kind === 'this' ? picked === null : picked?.node === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  className={`dev-where-row${on ? ' is-on' : ''}`}
                  disabled={!pickable}
                  title={r.kind === 'device' && r.why ? t('devices.cannotPick', { why: r.why }) : undefined}
                  data-testid={`where-${r.id}`}
                  onClick={() => {
                    setPickedNode(r.kind === 'this' ? null : r.id);
                    setOpen(false);
                  }}
                >
                  <span>{r.label}</span>
                  <small>{r.kind === 'this' ? where.view!.name : r.kind === 'device' ? stateSentence(r.device) : ''}</small>
                </button>
              );
            })}
            <button type="button" role="menuitem" className="dev-where-row" data-testid="where-add" onClick={() => (setOpen(false), where.onAddDevice())}>
              <span>{t('devices.addDots')}</span>
            </button>
          </div>
        )}
      </div>
      {picked && bridge ? (
        <PhoneNewChat
          key={picked.node}
          bridge={bridge}
          canControl={picked.level === 'full'}
          onClose={() => setPickedNode(null)}
          onStarted={(paneId, lane) => {
            setPickedNode(null);
            where.onStarted(picked, paneId, lane === 'chat');
          }}
        />
      ) : (
        children
      )}
    </>
  );
}
