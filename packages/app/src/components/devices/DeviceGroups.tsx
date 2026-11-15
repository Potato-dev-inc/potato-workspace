// The sidebar groups of other devices: `Mac mini · 2` with a state dot and one word when not fine (offline, not
// allowed). A row looks like a local row plus a small device mark. An offline group keeps its rows, greyed, with
// "Last seen 14:02". Which groups are folded is remembered. Everything here came from another device: text only.
import { useState } from 'react';
import { useT } from '../../i18n';
import { deviceNotices, stateWord } from '../../lib/devices';
import { RowMark } from '../cockpit/RowMark';
import { DeviceNotices } from './DeviceNotices';
import type { DeviceGroup, RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

const FOLDED_KEY = 'pm.devices.folded';

function readFolded(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(FOLDED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeFolded(set: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(FOLDED_KEY, JSON.stringify([...set]));
  } catch {
    /* a private window: the fold is just not remembered */
  }
}

export function DeviceGroups({ groups, selectedKey, onOpen, onRetry }: { groups: DeviceGroup[]; selectedKey: string | null; onOpen: (row: RemoteRow) => void; onRetry?: () => void }) {
  const t = useT();
  const [folded, setFolded] = useState<ReadonlySet<string>>(readFolded);
  const toggle = (node: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(node)) next.add(node);
      writeFolded(next);
      return next;
    });
  return (
    <>
      {groups.map(({ device, rows }) => {
        const word = stateWord(device);
        const off = device.state !== 'online';
        const open = !folded.has(device.node);
        return (
          <div key={device.node} className={`dev-group${off ? ' is-off' : ''}`} data-testid={`device-group-${device.node}`} data-state={device.state}>
            <button type="button" className="dev-group-head" aria-expanded={open} onClick={() => toggle(device.node)}>
              <span className={`dev-dot${device.state === 'online' ? ' is-up' : ''}`} aria-hidden="true" />
              <span>{rows.length > 0 ? `${device.name} · ${rows.length}` : device.name}</span>
              {word && <span className="dev-word">{word}</span>}
            </button>
            {/* Sign-ins that are missing show on the chat itself, not here. */}
            {open && <DeviceNotices notices={deviceNotices(device, [])} onRetry={onRetry} className="dev-group-note" />}
            {open &&
              rows.map((r) => {
                const asking = r.status === 'waiting_input';
                const active = selectedKey === r.key;
                return (
                  <div key={r.key} className="ck-rowwrap">
                    <button
                      type="button"
                      data-pane-row={r.key}
                      disabled={off}
                      className={`ck-row ck-row--slim${active ? ' is-active' : ''}${asking ? ' is-needs' : ''}${r.status === 'error' ? ' is-error' : ''}${r.status === 'idle' ? ' is-idle' : ''}`}
                      onClick={() => onOpen(r)}
                      aria-current={active ? 'true' : undefined}
                      title={`${r.title} · ${t('devices.onDevice', { name: device.name })}`}
                    >
                      <span className="ck-row-glyph">
                        <RowMark status={r.status} asking={asking} agentId={r.agent} />
                      </span>
                      <span className="ck-row-main">
                        <span className="ck-row-title">
                          {r.title}
                          <span className="dev-mark" aria-hidden="true">
                            {device.name}
                          </span>
                        </span>
                        <span className="ck-row-sub">{r.cwd}</span>
                      </span>
                      {asking && <span className="ck-row-pill">{t('sidebar.needsYou')}</span>}
                    </button>
                  </div>
                );
              })}
          </div>
        );
      })}
    </>
  );
}
