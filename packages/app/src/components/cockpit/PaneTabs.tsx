// The open panes of this project as tabs: the agent's icon, the task title, and a live state dot on the tabs that are
// not in front. The front tab is lifted to the work-area colour with a 2px accent line. Close shows on hover.
// Shown only when the project has two or more panes. Nothing here names an agent: the icon comes from the registry.
import type { CockpitApi } from '../../hooks/useCockpit';
import { isBusyStatus } from '../../lib/close-policy';
import { AgentLogo } from '../common/AgentLogo';
import { folderKey } from './history-model';
import { IconClose } from './Icons';
import { paneHeading } from './titles';
import '../../styles/pane-tabs.css';

export type TabDot = 'working' | 'needs' | 'error' | null;

/** The dot a background tab shows: needs you (orange) wins over working (green); a broken pane is red. */
export function tabDot(status: string, asking: boolean): TabDot {
  if (status === 'error') return 'error';
  if (asking || status === 'waiting_input') return 'needs';
  if (status === 'running') return 'working';
  return null;
}

const DOT_LABEL: Record<Exclude<TabDot, null>, string> = { working: 'Working', needs: 'Needs you', error: 'Error' };

export function PaneTabs({ c, paneId }: { c: CockpitApi; paneId: string }) {
  const list = c.registry.paneList;
  const self = list.find((p) => p.info.id === paneId);
  const key = folderKey(self?.info.cwd);
  const tabs = key ? list.filter((p) => folderKey(p.info.cwd) === key) : [];
  if (tabs.length < 2) return null;
  return (
    <div className="ck-ptabs" role="tablist" aria-label="Open agents in this project" data-testid="pane-tabs">
      {tabs.map((p) => {
        const id = p.info.id;
        const active = id === paneId;
        const agentName = c.names?.get(id) ?? p.info.agent_type;
        const title = paneHeading(p.info, agentName).primary;
        const asking = Boolean(c.prompts?.[id]);
        const dot = active ? null : tabDot(p.status, asking);
        const canClose = !isBusyStatus(p.status) && !asking;
        return (
          <div key={id} className={`ck-ptab${active ? ' is-active' : ''}`} data-pane-tab={id}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="ck-ptab-main"
              title={`${agentName} · ${title}`}
              onClick={() => c.select(id)}
            >
              <AgentLogo id={p.info.agent_type} name={agentName} size={14} decorative />
              <span className="ck-ptab-title">{title}</span>
            </button>
            {dot && <span className={`ck-ptab-dot ck-ptab-dot--${dot}`} role="img" aria-label={DOT_LABEL[dot]} data-testid="pane-tab-dot" />}
            {canClose && (
              <button type="button" className="ck-ptab-x" aria-label={`Close ${title}`} onClick={() => void c.closePane(id)}>
                <IconClose />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
