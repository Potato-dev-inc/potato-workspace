// Another PC's projects, in the sidebar's one Projects list (no section of their own). Each project of another device is a
// card like this PC's, with a small badge beside its name: the device's name. Its agent rows are the normal rows, with the
// same "N helpers" fold, and open the same way. A device that is offline, asleep, closed or needs a person says so above its
// projects. Everything here came from another device: text only.
import { Fragment, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { deviceNotices, stateWord } from '../../lib/devices';
import { onFocusDeviceGroup } from '../../lib/openDevice';
import { locationBadge } from '../../lib/projectLocation';
import { ProjectHeader } from '../cockpit/ProjectHeader';
import { SidebarWorkflowRow } from '../cockpit/SidebarWorkflowRow';
import { paneRowFacts } from '../cockpit/rail/rowFacts';
import { multiLoginAgents, paneHeading } from '../cockpit/titles';
import { paneNames } from '../cockpit/model';
import { descendants, groupHelperTree, isMinionPane, type HelperNode } from '../../lib/pane-helpers';
import { useHelpersInSidebar } from '../../lib/helpersInSidebar';
import { helpersOfFront } from '../../lib/workflow-model';
import { useWorkflowsEnabled } from '../../lib/workflow-live';
import { useCrewMarks } from '../../lib/crew-members';
import { paneOf } from '../../lib/host/farCockpit';
import type { PaneData } from '../../hooks/usePaneRegistry';
import { AgentRowButton } from '../cockpit/AgentRowButton';
import { IconMore } from '../cockpit/Icons';
import { DeviceNotices } from './DeviceNotices';
import type { ProjectEntry } from './useAllProjects';
import type { DeviceGroup, RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

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

export function RemoteProjects({
  groups,
  entries,
  selectedKey,
  onOpen,
  onRetry,
  launchEntries,
  onNewAgent,
}: {
  groups: DeviceGroup[];
  /** The remote projects of `groups` (the entries from useAllProjects that have no folder on this PC). */
  entries: ProjectEntry[];
  selectedKey: string | null;
  onOpen: (row: RemoteRow) => void;
  onRetry?: () => void;
  /** The agents' names, as this PC's sidebar has them. */
  launchEntries: ReadonlyArray<{ type: string; label: string }>;
  /** The header's "+": the normal New agent page, on this project and on its PC. */
  onNewAgent?: (entry: ProjectEntry) => void;
}) {
  const t = useT();
  const workflowsOn = useWorkflowsEnabled();
  useCrewMarks();
  const [showHelperTree] = useHelpersInSidebar();
  const agentLabel = (id: string) => launchEntries.find((e) => e.type === id)?.label ?? id;
  const [foldedProjects, setFoldedProjects] = useState<ReadonlySet<string>>(() => readFolded(FOLDED_PROJECTS_KEY));
  const [foldedKids, setFoldedKids] = useState<ReadonlySet<string>>(() => readFolded(FOLDED_KIDS_KEY));
  const flip = (key: string, set: ReadonlySet<string>, setter: (s: ReadonlySet<string>) => void) => (id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    writeFolded(key, next);
    setter(next);
  };
  const toggleProject = flip(FOLDED_PROJECTS_KEY, foldedProjects, setFoldedProjects);
  const toggleKids = flip(FOLDED_KIDS_KEY, foldedKids, setFoldedKids);
  // Open on Connect: unfold that PC's projects and scroll to its first card (after the unfolded rows are drawn).
  const [focus, setFocus] = useState<{ node: string; n: number } | null>(null);
  useEffect(
    () =>
      onFocusDeviceGroup((node) => {
        setFoldedProjects((prev) => {
          const next = new Set([...prev].filter((k) => !k.startsWith(`dev:${node}:`)));
          if (next.size === prev.size) return prev;
          writeFolded(FOLDED_PROJECTS_KEY, next);
          return next;
        });
        setFocus((f) => ({ node, n: (f?.n ?? 0) + 1 }));
      }),
    [],
  );
  useEffect(() => {
    if (!focus) return;
    const el = Array.from(document.querySelectorAll<HTMLElement>('[data-remote-node]')).find((x) => x.dataset.remoteNode === focus.node);
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [focus]);

  return (
    <>
      {groups.map((group) => {
        const { device } = group;
        const notices = deviceNotices(device, []);
        const mine = entries.filter((e) => e.location.kind === 'device' && e.location.node === device.node);
        if (notices.length === 0 && mine.length === 0) return null;
        const off = device.state !== 'online';
        const word = stateWord(device) ?? undefined;
        // The same pipeline as this PC's own sidebar, over this PC's rows as pane data: names numbered like there, a standby's own
        // chat and a minion never listed, helpers nested under their chat (status groups first), the workflow row under its front.
        const all = mine.flatMap((e) => e.rows);
        const rowByKey = new Map(all.map((r) => [r.key, r] as const));
        const paneAll = all.map((r) => paneOf(device.node, device.name, r));
        const names = paneNames(paneAll, agentLabel);
        const multiLogin = multiLoginAgents(paneAll.map((p) => p.info));
        const grouped = groupHelperTree(paneAll.filter((p) => !p.info.standby_seat && !isMinionPane(p.info)));
        const roots = [...grouped.needs, ...grouped.working, ...grouped.idle].filter((n) => !n.awayFrom);
        type Node = HelperNode<PaneData>;
        const rowOf = (n: Node, nested: boolean, helperCount: number): JSX.Element => {
          const p = n.pane;
          const r = rowByKey.get(p.info.id)!;
          const name = names.get(p.info.id) ?? p.info.agent_type;
          const { heading, subline, where } = paneRowFacts(p, { name, multiLogin, copy: r.copy }, t);
          const label = agentLabel(p.info.agent_type);
          return (
            <div key={r.key} className="ck-rowwrap">
              <AgentRowButton
                id={r.key}
                status={r.status}
                agentType={r.agent}
                agentLabel={label}
                title={heading.primary}
                active={selectedKey === r.key}
                asking={r.status === 'waiting_input'}
                nested={nested}
                helperCount={helperCount}
                sub={<span className="ck-row-sub">{subline}</span>}
                tip={[...new Set([heading.primary, label, subline, where, t('devices.onDevice', { name: device.name })])].filter(Boolean).join(' · ')}
                onClick={() => onOpen(r)}
              />
              <button type="button" className="ck-row-more" disabled aria-label={t('sidebar.moreFor', { name: heading.primary })} title={t('devices.row.noMenu', { name: device.name })}>
                <IconMore />
              </button>
            </div>
          );
        };
        const wfRow = (n: Node): JSX.Element | null => {
          const r = rowByKey.get(n.pane.info.id);
          if (!workflowsOn || !r?.workflow?.front) return null;
          const helpers = helpersOfFront(null, paneAll, r.key, (x) => names.get(x.info.id) ?? x.info.agent_type);
          if (helpers.length === 0) return null;
          return <SidebarWorkflowRow key={`wf-${r.key}`} frontId={r.key} name={r.workflow.name ?? null} helpers={helpers} active={selectedKey === r.key} onOpen={() => onOpen(r)} />;
        };
        // A row, and under it its helpers behind the "N helpers" chip: a spin-off always, the others when the person wants the tree.
        const node = (n: Node, parent?: Node): JSX.Element => {
          const r = rowByKey.get(n.pane.info.id)!;
          const kids = showHelperTree ? n.helpers : n.helpers.filter((h) => h.pane.info.started_as === 'spin_off');
          const nested = !!parent && n.pane.info.started_as === 'spin_off';
          const wf = wfRow(n);
          if (kids.length === 0 && !wf) return rowOf(n, nested, showHelperTree ? 0 : descendants(n).length);
          const id = `${device.node}|${r.paneId}`;
          const kidsOpen = !foldedKids.has(id);
          const title = paneHeading(n.pane.info, names.get(n.pane.info.id) ?? n.pane.info.agent_type).primary;
          return (
            <div key={r.key} className="ck-node">
              {rowOf(n, nested, showHelperTree ? 0 : descendants(n).length - kids.length)}
              {wf}
              {kids.length > 0 && (
                <div className="ck-helpers" role="group" aria-label={t('sidebar.helpersOf', { name: title })}>
                  <button type="button" className="ck-chip-count ck-helper-chip" onClick={() => toggleKids(id)} aria-expanded={kidsOpen} title={t(kidsOpen ? 'sidebar.hideHelpers' : 'sidebar.showHelpers')}>
                    {t('state.helpers', { count: showHelperTree ? descendants(n).length : kids.length })}
                    <span className={`ck-helper-caret${kidsOpen ? ' is-open' : ''}`} aria-hidden="true" />
                  </button>
                  {kidsOpen && kids.map((k) => node(k, n))}
                </div>
              )}
            </div>
          );
        };
        return (
          <Fragment key={device.node}>
            {/* Sign-ins that are missing show on the chat itself, not here. */}
            {notices.length > 0 && (
              <div data-remote-node={device.node}>
                <DeviceNotices notices={notices} onRetry={onRetry} className="dev-group-note" />
              </div>
            )}
            {mine.map((e) => {
              const folded = foldedProjects.has(e.key);
              const keys = new Set(e.rows.map((r) => r.key));
              const shown = roots.filter((n) => keys.has(n.pane.info.id));
              const everyPane = shown.flatMap((n) => [n.pane, ...descendants(n).map((d) => d.pane)]);
              return (
                <div
                  className={`ck-proj${off ? ' is-off' : ''}`}
                  key={e.key}
                  role="group"
                  aria-label={e.name}
                  data-testid={`device-project-${e.key}`}
                  data-remote-node={device.node}
                  data-state={device.state}
                >
                  <div className="ck-proj-drag">
                    <ProjectHeader
                      name={e.name}
                      count={everyPane.length}
                      folded={folded}
                      needs={everyPane.some((p) => p.status === 'waiting_input' || p.status === 'error')}
                      agents={shown.map((n) => ({ id: n.pane.info.id, agentType: n.pane.info.agent_type, label: agentLabel(n.pane.info.agent_type) }))}
                      added
                      hasFolder
                      unavailable={t('devices.notOnYet', { name: device.name })}
                      badge={locationBadge(e.location)}
                      note={word}
                      onToggle={() => toggleProject(e.key)}
                      onNewAgent={() => onNewAgent?.(e)}
                      onAdd={() => {}}
                      onRemove={() => {}}
                      onRename={() => {}}
                    />
                  </div>
                  {!folded && <div className="ck-proj-kids">{shown.map((n) => node(n))}</div>}
                </div>
              );
            })}
          </Fragment>
        );
      })}
    </>
  );
}
