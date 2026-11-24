// Another PC's projects, in the sidebar's one Projects list (no section of their own). Each project of another device is a
// card like this PC's, with a small badge beside its name: the device's name. Its agent rows are the normal rows, with the
// same "N helpers" fold, and open the same way. A device that is offline, asleep, closed or needs a person says so above its
// projects. Everything here came from another device: text only.
import { Fragment, useEffect, useRef, useState } from 'react';
import { Menu } from '../common/Floating';
import { useT } from '../../i18n';
import { deviceNotices, stateWord } from '../../lib/devices';
import { onFocusDeviceGroup } from '../../lib/openDevice';
import { locationBadge } from '../../lib/projectLocation';
import { ProjectHeader, ProjectMeta } from '../cockpit/ProjectHeader';
import { groupByBranch, primaryBranch, type PaneCard } from '../cockpit/useProjectCard';
import type { WorktreeItem } from '../../lib/cockpit-api';
import { SidebarWorkflowRow } from '../cockpit/SidebarWorkflowRow';
import { paneRowFacts } from '../cockpit/rail/rowFacts';
import { multiLoginAgents, paneHeading } from '../cockpit/titles';
import { paneNames } from '../cockpit/model';
import { requestPaneAction } from '../../lib/pane-actions';
import { descendants, groupHelperTree, isMinionPane, type HelperNode } from '../../lib/pane-helpers';
import { useHelpersInSidebar } from '../../lib/helpersInSidebar';
import { helpersOfFront } from '../../lib/workflow-model';
import { useWorkflowsEnabled } from '../../lib/workflow-live';
import { useCrewMarks } from '../../lib/crew-members';
import { farAgentName, farChatName, paneOf, uniqueFarNames } from '../../lib/host/farCockpit';
import type { PaneData } from '../../hooks/usePaneRegistry';
import { AgentRowButton } from '../cockpit/AgentRowButton';
import { IconMore } from '../cockpit/Icons';
import { DeviceNotices } from './DeviceNotices';
import type { ProjectEntry } from './useAllProjects';
import type { DeviceGroup, RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

const FOLDED_PROJECTS_KEY = 'pm.devices.foldedProjects';
const FOLDED_KIDS_KEY = 'pm.devices.foldedKids';
// This PC's own say about another PC's projects: a name it chose, and the ones it hid (with the chats they had then: a new chat brings the project back).
const ALIASES_KEY = 'pm.devices.projectAliases';
const HIDDEN_KEY = 'pm.devices.hiddenProjects';

function readMap<T>(key: string, ok: (v: unknown) => v is T): Record<string, T> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, T] => ok(e[1])));
  } catch {
    return {};
  }
}
const isText = (v: unknown): v is string => typeof v === 'string';
const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
function writeMap(key: string, map: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* a private window: it is just not remembered */
  }
}

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
  const agentLabel = (id: string) => launchEntries.find((e) => e.type === id)?.label ?? farAgentName(id);
  const [foldedProjects, setFoldedProjects] = useState<ReadonlySet<string>>(() => readFolded(FOLDED_PROJECTS_KEY));
  // The row menu of a chat on another PC: the "···" button and a right-click (or Shift+F10) open the same one: Open, Rename and Close
  // (the last two run in the chat's own screen, which asks that PC).
  const [rowMenu, setRowMenu] = useState<{ row: RemoteRow; name: string; x: number; y: number } | null>(null);
  const rowMenuFrom = useRef<HTMLElement | null>(null);
  const [foldedKids, setFoldedKids] = useState<ReadonlySet<string>>(() => readFolded(FOLDED_KIDS_KEY));
  const [aliases, setAliases] = useState(() => readMap(ALIASES_KEY, isText));
  const [hiddenProjects, setHiddenProjects] = useState(() => readMap(HIDDEN_KEY, isList));
  const rename = (key: string, name: string) => {
    const next = { ...aliases };
    // The name this PC chose (40 letters at most); an empty one gives the far name back.
    if (name.trim()) next[key] = name.trim().slice(0, 40);
    else delete next[key];
    writeMap(ALIASES_KEY, next);
    setAliases(next);
  };
  const hideProject = (e: ProjectEntry) => {
    const next = { ...hiddenProjects, [e.key]: e.rows.map((r) => r.key) };
    writeMap(HIDDEN_KEY, next);
    setHiddenProjects(next);
  };
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
        // Named, so a line that comes first in a group is never read as belonging to the project above it.
        const notices = deviceNotices(device, []).map((n) => (n.kind === 'state' ? { ...n, text: `${device.name} · ${n.text}` } : n));
        const mine = entries.filter((e) => e.location.kind === 'device' && e.location.node === device.node && (!hiddenProjects[e.key] || e.rows.some((r) => !hiddenProjects[e.key]!.includes(r.key))));
        if (notices.length === 0 && mine.length === 0) return null;
        const off = device.state !== 'online';
        const word = stateWord(device) ?? undefined;
        // The same pipeline as this PC's own sidebar, over this PC's rows as pane data: names numbered like there, a standby's own
        // chat and a minion never listed, helpers nested under their chat (status groups first), the workflow row under its front.
        const all = mine.flatMap((e) => e.rows);
        const rowByKey = new Map(all.map((r) => [r.key, r] as const));
        const paneAll = all.map((r) => paneOf(device.node, device.name, r));
        const names = paneNames(paneAll, agentLabel, false);
        // The owning PC's own number wins: this PC counts a different set of chats and would name the same chat "Claude 11" for "Claude 5".
        for (const r of all) {
          const own = farChatName(agentLabel(r.agent), r);
          if (own) names.set(r.key, own);
        }
        uniqueFarNames(names, all, agentLabel);
        const multiLogin = multiLoginAgents(paneAll.map((p) => p.info));
        const grouped = groupHelperTree(paneAll.filter((p) => !p.info.standby_seat && !isMinionPane(p.info)));
        // Attention is a marker, not a position: roots keep the order the device sent, not the needs/working/idle grouping.
        const rank = new Map(paneAll.map((p, i) => [p.info.id, i] as const));
        const roots = [...grouped.needs, ...grouped.working, ...grouped.idle].filter((n) => !n.awayFrom).sort((a, b) => (rank.get(a.pane.info.id) ?? 0) - (rank.get(b.pane.info.id) ?? 0));
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
                // A PC that is away works on, but this PC cannot see it: no "working" mark for what it cannot know.
                status={off && (r.status === 'running' || r.status === 'waiting_input') ? 'away' : r.status}
                agentType={r.agent}
                agentLabel={label}
                title={heading.primary}
                active={selectedKey === r.key}
                asking={r.status === 'waiting_input'}
                nested={nested}
                helperCount={helperCount}
                sub={<span className="ck-row-sub">{r.ended ? [subline, t('r15far.ended')].filter(Boolean).join(' · ') : subline}</span>}
                tip={[...new Set([heading.primary, label, subline, where, t('devices.onDevice', { name: device.name })])].filter(Boolean).join(' · ')}
                onClick={() => onOpen(r)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  rowMenuFrom.current = e.currentTarget;
                  // From the keyboard (the context-menu key, Shift+F10) there is no pointer: it opens at the row, as for a chat of this PC.
                  const b = e.currentTarget.getBoundingClientRect();
                  const fromKeyboard = e.clientX === 0 && e.clientY === 0;
                  setRowMenu({ row: r, name: device.name, x: fromKeyboard ? b.left + 24 : e.clientX, y: fromKeyboard ? b.bottom - 4 : e.clientY });
                }}
              />
              <button
                type="button"
                className="ck-row-more"
                aria-label={t('sidebar.moreFor', { name: heading.primary })}
                title={t('sidebar.more')}
                aria-haspopup="menu"
                onClick={(e) => {
                  rowMenuFrom.current = e.currentTarget;
                  const b = e.currentTarget.getBoundingClientRect();
                  setRowMenu({ row: r, name: device.name, x: b.left, y: b.bottom + 2 });
                }}
              >
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
            {/* The PC's notes are drawn inside its own first project card (so they sit in its group, not under the project above); a PC with no project card keeps them alone. */}
            {notices.length > 0 && mine.length === 0 && (
              <div data-remote-node={device.node}>
                <DeviceNotices notices={notices} onRetry={onRetry} className="dev-group-note" />
              </div>
            )}
            {mine.map((e, index) => {
              const folded = foldedProjects.has(e.key);
              const keys = new Set(e.rows.map((r) => r.key));
              const shown = roots.filter((n) => keys.has(n.pane.info.id));
              const everyPane = shown.flatMap((n) => [n.pane, ...descendants(n).map((d) => d.pane)]);
              // The branch and copy rows of this PC's own card, from what the far PC says about each chat (its branch name and whether it works on a copy).
              const cards = new Map<string, PaneCard>(
                e.rows.map((r) => [r.key, { branch: r.branch ?? null, copy: r.copy ? ({ handle: r.branch ?? r.key, branch: r.branch ?? '' } as WorktreeItem) : null }] as const),
              );
              const shownIds = shown.map((n) => n.pane.info.id);
              const branchGroups = groupByBranch(shown, (n) => n.pane.info.id, cards);
              const mainBranch = primaryBranch(shownIds, cards);
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
                      name={aliases[e.key] ?? e.name}
                      count={everyPane.length}
                      folded={folded}
                      needs={everyPane.some((p) => p.status === 'waiting_input' || p.status === 'error')}
                      agents={shown.map((n) => ({ id: n.pane.info.id, agentType: n.pane.info.agent_type, label: agentLabel(n.pane.info.agent_type) }))}
                      added
                      hasFolder
                      badge={locationBadge(e.location)}
                      note={word}
                      onToggle={() => toggleProject(e.key)}
                      onNewAgent={() => onNewAgent?.(e)}
                      onAdd={() => {}}
                      onRemove={() => hideProject(e)}
                      onRename={(name) => rename(e.key, name)}
                    />
                  </div>
                  {index === 0 && notices.length > 0 && <DeviceNotices notices={notices} onRetry={onRetry} className="dev-group-note" />}
                  {!folded && !branchGroups && mainBranch && <ProjectMeta branch={mainBranch} />}
                  {!folded && (
                    <div className="ck-proj-kids">
                      {branchGroups
                        ? branchGroups.map((bg) => (
                            <div className="ck-branch-group" key={bg.key} role="group" aria-label={bg.label || t('sidebar.projectFolder')}>
                              <div className="ck-branch-head">
                                <span className="ck-proj-branch" title={bg.label}>
                                  {bg.label || t('sidebar.noBranch')}
                                </span>
                                <span className="ck-pill-quiet">{bg.copy ? t('sidebar.copy') : t('sidebar.primary')}</span>
                              </div>
                              {bg.items.map((n) => node(n))}
                            </div>
                          ))
                        : shown.map((n) => node(n))}
                    </div>
                  )}
                </div>
              );
            })}
          </Fragment>
        );
      })}
      {rowMenu && (
        <Menu
          point={{ x: rowMenu.x, y: rowMenu.y }}
          align="start"
          className="ck-menu--compact"
          label={t('sidebar.paneActions')}
          onContextMenu={(e) => e.preventDefault()}
          onClose={(back) => {
            setRowMenu(null);
            if (back) rowMenuFrom.current?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="ck-menu-item"
            tabIndex={-1}
            onClick={() => {
              setRowMenu(null);
              onOpen(rowMenu.row);
            }}
          >
            <span>{t('devices.row.open')}</span>
          </button>
          {/* Rename and Close run in the pane's own screen (the same ones as its header): open it, then ask its view. A terminal has Close only. */}
          {(
            <>
              {((rowMenu.row.chat ? ['rename', 'close'] : ['close']) as Array<'rename' | 'close'>).map((action) => (
                <button
                  key={action}
                  type="button"
                  role="menuitem"
                  className="ck-menu-item"
                  tabIndex={-1}
                  onClick={() => {
                    setRowMenu(null);
                    onOpen(rowMenu.row);
                    requestPaneAction(rowMenu.row.key, action);
                  }}
                >
                  <span>{t(action === 'rename' ? 'sidebar.rename' : 'sidebar.close')}</span>
                </button>
              ))}
            </>
          )}
        </Menu>
      )}
    </>
  );
}
