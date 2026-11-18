// Another PC's section of the sidebar, built like This PC's: a heading with its name, then "Projects", a header per folder and the same
// agent rows (AgentRowButton) with the same "N helpers" fold. An offline section keeps its last rows (still openable, read-only) with its
// notice. Which sections, projects and helper groups are folded is remembered. Everything here came from another device: text only.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { deviceNotices, stateWord } from '../../lib/devices';
import { onFocusDeviceGroup } from '../../lib/openDevice';
import { ProjectHeader } from '../cockpit/ProjectHeader';
import { AgentRowButton } from '../cockpit/AgentRowButton';
import { IconMore } from '../cockpit/Icons';
import { DeviceNotices } from './DeviceNotices';
import type { DeviceGroup, RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

const FOLDED_KEY = 'pm.devices.folded';
const FOLDED_PROJECTS_KEY = 'pm.devices.foldedProjects';
const FOLDED_KIDS_KEY = 'pm.devices.foldedKids';

function readFolded(key: string): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeFolded(key: string, set: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* a private window: the fold is just not remembered */
  }
}


/** A device's panes grouped by folder, like the sidebar's Projects on this PC (the order the far PC listed them in). */
function projectsOf(rows: RemoteRow[]): { key: string; name: string; rows: RemoteRow[] }[] {
  const byFolder = new Map<string, RemoteRow[]>();
  const keyOf = (r: RemoteRow) => r.project || r.cwd || '';
  for (const r of rows) byFolder.set(keyOf(r), [...(byFolder.get(keyOf(r)) ?? []), r]);
  return [...byFolder.entries()].map(([key, list]) => ({ key: key || '-', name: list[0]?.cwd || '·', rows: list }));
}

export function DeviceGroups({ groups, selectedKey, onOpen, onRetry }: { groups: DeviceGroup[]; selectedKey: string | null; onOpen: (row: RemoteRow) => void; onRetry?: () => void }) {
  const t = useT();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => readFolded(FOLDED_KEY));
  const [foldedProjects, setFoldedProjects] = useState<ReadonlySet<string>>(() => readFolded(FOLDED_PROJECTS_KEY));
  const [foldedKids, setFoldedKids] = useState<ReadonlySet<string>>(() => readFolded(FOLDED_KIDS_KEY));
  const flip = (key: string, set: ReadonlySet<string>, setter: (s: ReadonlySet<string>) => void) => (id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    writeFolded(key, next);
    setter(next);
  };
  // Open on Connect: unfold that PC's section and scroll to it (after the unfolded rows are drawn).
  const [focus, setFocus] = useState<{ node: string; n: number } | null>(null);
  useEffect(
    () =>
      onFocusDeviceGroup((node) => {
        setFolded((prev) => {
          if (!prev.has(node)) return prev;
          const next = new Set(prev);
          next.delete(node);
          writeFolded(FOLDED_KEY, next);
          return next;
        });
        setFocus((f) => ({ node, n: (f?.n ?? 0) + 1 }));
      }),
    [],
  );
  useEffect(() => {
    if (!focus) return;
    const el = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="device-group-"]')).find((x) => x.getAttribute('data-testid') === `device-group-${focus.node}`);
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [focus]);
  const toggle = flip(FOLDED_KEY, folded, setFolded);
  const toggleProject = flip(FOLDED_PROJECTS_KEY, foldedProjects, setFoldedProjects);
  const toggleKids = flip(FOLDED_KIDS_KEY, foldedKids, setFoldedKids);
  return (
    <>
      {groups.map(({ device, rows }) => {
        const word = stateWord(device);
        const off = device.state !== 'online';
        const open = !folded.has(device.node);
        // One row, and under it the panes it started (a helper or minion), folded by the same "N helpers" chip as on this PC.
        const rowOf = (r: RemoteRow, nested: boolean): JSX.Element => {
          const active = selectedKey === r.key;
          return (
            <div key={r.key} className="ck-rowwrap">
              <AgentRowButton
                id={r.key}
                status={r.status}
                agentType={r.agent}
                title={r.title}
                active={active}
                asking={r.status === 'waiting_input'}
                nested={nested}
                helperCount={0}
                sub={<span className="ck-row-sub">{r.cwd}</span>}
                tip={[r.title, r.cwd, t('devices.onDevice', { name: device.name })].filter(Boolean).join(' · ')}
                onClick={() => onOpen(r)}
              />
              <button type="button" className="ck-row-more" disabled aria-label={t('sidebar.moreFor', { name: r.title })} title={t('devices.row.noMenu', { name: device.name })}>
                <IconMore />
              </button>
            </div>
          );
        };
        const node = (r: RemoteRow, list: RemoteRow[], nested: boolean): JSX.Element => {
          const kids = list.filter((k) => k.parent === r.paneId);
          if (kids.length === 0) return rowOf(r, nested);
          const id = `${device.node}|${r.paneId}`;
          const kidsOpen = !foldedKids.has(id);
          return (
            <div key={r.key} className="ck-node">
              {rowOf(r, nested)}
              <div className="ck-helpers" role="group" aria-label={t('sidebar.helpersOf', { name: r.title })}>
                <button type="button" className="ck-chip-count ck-helper-chip" onClick={() => toggleKids(id)} aria-expanded={kidsOpen} title={t(kidsOpen ? 'sidebar.hideHelpers' : 'sidebar.showHelpers')}>
                  {t('state.helpers', { count: kids.length })}
                  <span className={`ck-helper-caret${kidsOpen ? ' is-open' : ''}`} aria-hidden="true" />
                </button>
                {kidsOpen && kids.map((k) => node(k, list, true))}
              </div>
            </div>
          );
        };
        return (
          <div key={device.node} className={`dev-group${off ? ' is-off' : ''}`} data-testid={`device-group-${device.node}`} data-state={device.state}>
            {/* The heading of this PC's section is its name, like "This PC" above this PC's own list. */}
            <button type="button" className="dev-group-head dev-group-head--this" aria-expanded={open} onClick={() => toggle(device.node)}>
              <span className={`dev-dot${device.state === 'online' ? ' is-up' : ''}`} aria-hidden="true" />
              <span>{device.name}</span>
              {word && <span className="dev-word">{word}</span>}
            </button>
            {/* Sign-ins that are missing show on the chat itself, not here. */}
            {open && <DeviceNotices notices={deviceNotices(device, [])} onRetry={onRetry} className="dev-group-note" />}
            {open && rows.length > 0 && (
              <div className="ck-group">
                <div className="ck-caption">{t('sidebar.projects')}</div>
                {projectsOf(rows).map((g) => {
                  const fkey = `${device.node}|${g.key}`;
                  const foldedProj = foldedProjects.has(fkey);
                  return (
                    <div className="ck-proj" key={g.key} role="group" aria-label={g.name} data-testid={`device-project-${g.key}`}>
                      <div className="ck-proj-drag">
                        <ProjectHeader
                          name={g.name}
                          count={g.rows.length}
                          folded={foldedProj}
                          needs={g.rows.some((r) => r.status === 'waiting_input' || r.status === 'error')}
                          agents={g.rows.map((r) => ({ id: r.key, agentType: r.agent }))}
                          added={false}
                          hasFolder={false}
                          onToggle={() => toggleProject(fkey)}
                          onNewAgent={() => {}}
                          onAdd={() => {}}
                          onRemove={() => {}}
                          onRename={() => {}}
                        />
                      </div>
                      {!foldedProj && (
                        <div className="ck-proj-kids">
                          {g.rows.filter((r) => !r.parent || !g.rows.some((p) => p.paneId === r.parent)).map((r) => node(r, g.rows, false))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
