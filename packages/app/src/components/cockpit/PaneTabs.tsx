// The open panes of this project as tabs: the agent's icon, the task title, and a live state dot on the tabs that are
// not in front. The front tab is lifted to the work-area colour with a 2px accent line. Close shows on hover.
// Shown only when the project has two or more panes. Nothing here names an agent: the icon comes from the registry.
import type { CockpitApi } from '../../hooks/useCockpit';
import { isBusyStatus } from '../../lib/close-policy';
import { AgentLogo } from '../common/AgentLogo';
import { folderKey } from './history-model';
import { IconClose } from './Icons';
import { paneHeading } from './titles';
import { useT } from '../../i18n';
import { setFocusMode } from '../../lib/focus-mode';
import { usePaneTabOrder } from '../../lib/paneTabOrder';
import { dragSourceProps } from '../dnd/dragSourceProps';
import { ReorderList } from '../dnd/ReorderList';
import { applyOrder, moveToSlot } from '../dnd/reorder';
import '../../styles/pane-tabs.css';

export type TabDot = 'working' | 'needs' | 'error' | null;

/** The dot a background tab shows: needs you (orange) wins over working (green); a broken pane is red. */
export function tabDot(status: string, asking: boolean): TabDot {
  if (status === 'error') return 'error';
  if (asking || status === 'waiting_input') return 'needs';
  if (status === 'running') return 'working';
  return null;
}

export function PaneTabs({ c, paneId }: { c: CockpitApi; paneId: string }) {
  const t = useT();
  const dotLabel: Record<Exclude<TabDot, null>, string> = { working: t('pane.working'), needs: t('pane.needsYou'), error: t('pane.error') };
  const list = c.registry.paneList;
  const self = list.find((p) => p.info.id === paneId);
  const key = folderKey(self?.info.cwd);
  const { order, setOrder } = usePaneTabOrder(key ?? '');
  const tabs = applyOrder(key ? list.filter((p) => folderKey(p.info.cwd) === key) : [], (p) => p.info.id, order);
  if (tabs.length < 2) return null;
  const ids = tabs.map((p) => p.info.id);
  const titleOf = (id: string) => {
    const p = tabs.find((x) => x.info.id === id);
    return p ? paneHeading(p.info, c.names?.get(id) ?? p.info.agent_type).primary : id;
  };
  // Drag a tab sideways, or press Alt+Left / Alt+Right on it: the new order is saved for this project.
  const moveTab = (id: string, slot: number) => {
    const next = moveToSlot(ids, id, slot);
    if (next.join('|') === ids.join('|')) return;
    setOrder(next);
  };
  return (
    <ReorderList
      zoneId={`ptabs-${paneId}`}
      kind="tab"
      axis="x"
      priority={1}
      className="ck-ptabs"
      attrs={{ role: 'tablist', 'aria-label': t('pane.tabsLabel'), 'data-testid': 'pane-tabs' }}
      items={(box) =>
        ids.flatMap((id) => {
          const el = box.querySelector(`[data-pane-tab="${id}"]`);
          return el ? [{ id, el }] : [];
        })
      }
      accepts={(p) => ids.includes(p.id)}
      keyboardId={(el) => el.closest('[data-pane-tab]')?.getAttribute('data-pane-tab') ?? null}
      label={titleOf}
      onMove={(id, slot) => moveTab(id, slot)}
    >
      {tabs.map((p) => {
        const id = p.info.id;
        const active = id === paneId;
        const agentName = c.names?.get(id) ?? p.info.agent_type;
        const title = paneHeading(p.info, agentName).primary;
        const asking = Boolean(c.prompts?.[id]);
        const dot = active ? null : tabDot(p.status, asking);
        const canClose = !isBusyStatus(p.status) && !asking;
        return (
          <div key={id} className={`ck-ptab${active ? ' is-active' : ''}`} data-pane-tab={id} {...dragSourceProps({ kind: 'tab', id, label: title })}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="ck-ptab-main"
              title={`${agentName} · ${title} · ${t('pane.tabFocusTip')} · ${t('dnd.tabMoveTip')}`}
              onClick={() => c.select(id)}
              onDoubleClick={() => {
                // A double-click opens the tab and fills the window with it (focus mode, Esc brings the layout back).
                c.select(id);
                setFocusMode(true);
              }}
            >
              <AgentLogo id={p.info.agent_type} name={agentName} size={14} decorative />
              <span className="ck-ptab-title">{title}</span>
            </button>
            {dot && <span className={`ck-ptab-dot ck-ptab-dot--${dot}`} role="img" aria-label={dotLabel[dot]} data-testid="pane-tab-dot" />}
            {canClose && (
              <button type="button" className="ck-ptab-x" aria-label={t('pane.closeTab', { title })} onClick={() => void c.closePane(id)}>
                <IconClose />
              </button>
            )}
          </div>
        );
      })}
    </ReorderList>
  );
}
