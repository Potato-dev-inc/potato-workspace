// What a chat row says, from the pane's own facts: its first line (a title, else the agent's name), and its second line (who works and
// what it does, or where it works, "separate copy of shop" for a chat on a copy). One function for the rows of this PC and of another PC,
// so a far chat's row reads exactly as it does on its own PC. Pure.
import type { PaneInfo } from '@potato-workspace/shared';
import { paneHeading, paneSubline } from '../titles';
import { projectWithCopy } from '../shell-labels';
import type { t as translate } from '../../../i18n';

type T = typeof translate;

export interface RowFacts {
  heading: ReturnType<typeof paneHeading>;
  subline: string;
  /** The project the chat works in, by name ("separate copy of shop" on a copy). */
  where: string;
}

export function paneRowFacts(
  p: { info: PaneInfo; status: string },
  o: { name: string; /** What it is doing now (`activityText`), if known. */ activity?: string | null; /** The title of the parent when this row is listed away from it. */ awayFrom?: string; multiLogin: ReadonlySet<string>; copy?: boolean },
  t: T,
): RowFacts {
  const where = projectWithCopy(p.info.cwd, o.copy);
  const detail = o.activity ?? (p.status === 'error' ? t('sidebar.errorIn', { where }) : where);
  return {
    heading: paneHeading(p.info, o.name),
    subline: paneSubline(p.info, o.name, o.awayFrom ? t('sidebar.helperOf', { name: o.awayFrom, detail }) : detail, o.multiLogin),
    where,
  };
}
