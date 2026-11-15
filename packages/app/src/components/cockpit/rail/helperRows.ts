// The rail's Background tasks rows for helpers: the panes whose live parent is this pane, in list order.
import { liveParentId } from '../../../lib/pane-helpers';
import { paneHeading } from '../titles';
import type { HelperRow } from './BackgroundSection';

interface PaneLike {
  info: { id: string; title?: string | null; parent_pane_id?: string | null; agent_type?: string };
  status: string;
}

export function helperRows<T extends PaneLike>(list: ReadonlyArray<T>, paneId: string, agentNameOf: (pane: T) => string): HelperRow[] {
  return list
    .filter((p) => liveParentId(list, p.info.id) === paneId)
    .map((p) => {
      const heading = paneHeading(p.info, agentNameOf(p));
      return { id: p.info.id, title: heading.primary, agent: heading.secondary, agentType: p.info.agent_type ?? null, status: p.status };
    });
}
