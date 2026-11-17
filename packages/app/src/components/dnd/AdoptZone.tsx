// A main agent's row in the sidebar as a place to drop another agent: "Make helper of <name>". Only the middle half of the
// row takes the drop; the top and bottom quarters stay the place where a chat is dragged into a new order. While the pointer is
// over it the row shows what would happen (or why it cannot). Mount one inside each main agent's `.ck-rowwrap`: it measures its
// parent, so the row needs no other change.
import { useEffect, useRef } from 'react';
import '../../styles/cockpit-adopt.css';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { registerDropZone, useDrag, useDragOver, type DragPayload } from './dragStore';

export interface AdoptZoneProps {
  paneId: string;
  /** The shown name of this agent. */
  name: string;
  /** Why `childId` cannot become a helper of this agent (a message key), or null when it can. */
  refusal: (childId: string) => MessageKey | null;
  /** The drop: `childId` was let go on this agent. */
  onAdopt: (childId: string, parentId: string) => void;
  /**
   * A Background tasks row was let go on this agent (`bgtask`). In the middle of the row it is "onto the agent" (its own task: nothing
   * happens; another agent's: it can be handed over). At the bottom edge it is "under the agent" (its own task is shown nested there).
   * Without it the row takes no tasks.
   */
  onTask?: (payload: DragPayload, paneId: string, where: 'agent' | 'under') => void;
}

/** The share of the row's height, top and bottom, that is left to reordering. */
export const EDGE_SHARE = 0.25;

export function AdoptZone({ paneId, name, refusal, onAdopt, onTask }: AdoptZoneProps) {
  const mark = useRef<HTMLSpanElement>(null);
  const live = useRef({ onAdopt, onTask });
  live.current = { onAdopt, onTask };
  const zoneId = `adopt-${paneId}`;
  const taskZone = `adopt-task-${paneId}`;
  const underZone = `adopt-under-${paneId}`;
  const hasTask = onTask !== undefined;
  useEffect(() => {
    if (!hasTask) return;
    const rect = (from: 'middle' | 'bottom') => () => {
      const r = mark.current?.parentElement?.getBoundingClientRect();
      if (!r) return null;
      const edge = r.height * EDGE_SHARE;
      return from === 'middle' ? { left: r.left, right: r.right, top: r.top + edge, bottom: r.bottom - edge } : { left: r.left, right: r.right, top: r.bottom - edge, bottom: r.bottom };
    };
    const offs = [
      registerDropZone({ id: taskZone, priority: 6, accepts: (p) => p.kind === 'bgtask', getRect: rect('middle'), onDrop: (p) => live.current.onTask?.(p, paneId, 'agent') }),
      registerDropZone({ id: underZone, priority: 6, accepts: (p) => p.kind === 'bgtask', getRect: rect('bottom'), onDrop: (p) => live.current.onTask?.(p, paneId, 'under') }),
    ];
    return () => offs.forEach((off) => off());
  }, [hasTask, taskZone, underZone, paneId]);
  const overTask = useDragOver(taskZone);
  const overUnder = useDragOver(underZone);
  useEffect(
    () =>
      registerDropZone({
        id: zoneId,
        priority: 5,
        accepts: (p) => p.kind === 'chat' && p.id !== paneId,
        getRect: () => {
          const r = mark.current?.parentElement?.getBoundingClientRect();
          if (!r) return null;
          const edge = r.height * EDGE_SHARE;
          return { left: r.left, right: r.right, top: r.top + edge, bottom: r.bottom - edge };
        },
        onDrop: (p) => live.current.onAdopt(p.id, paneId),
      }),
    [zoneId, paneId],
  );
  const over = useDragOver(zoneId);
  return (
    <>
      <span ref={mark} className="ck-adopt-mark" aria-hidden="true" />
      {over && <AdoptPreview name={name} paneId={paneId} refusal={refusal} />}
      {(overTask || overUnder) && <TaskPreview name={name} paneId={paneId} where={overUnder ? 'under' : 'agent'} />}
    </>
  );
}

/** Drawn only while this row is the one under the pointer, so only one row follows every pointer move. */
function AdoptPreview({ name, paneId, refusal }: { name: string; paneId: string; refusal: AdoptZoneProps['refusal'] }) {
  const t = useT();
  const drag = useDrag();
  const why = drag ? refusal(drag.payload.id) : null;
  return (
    <span className={`ck-adopt-over${why ? ' is-refused' : ''}`} data-testid="adopt-preview" data-adopt-target={paneId} title={why ? t(why) : undefined}>
      {why ? t('adopt.refused', { name }) : t('adopt.preview', { name })}
    </span>
  );
}

/** What a Background tasks row would do here: nothing on its own agent's row, "Show under" at the bottom edge, "Hand to" on another agent. */
function TaskPreview({ name, paneId, where }: { name: string; paneId: string; where: 'agent' | 'under' }) {
  const t = useT();
  const drag = useDrag();
  const own = drag?.payload.meta?.owner === paneId;
  const isMinion = drag?.payload.meta?.kind === 'minion';
  const refused = where === 'agent' ? own || !isMinion : !own && !isMinion;
  const text = own ? (where === 'under' ? t('taskdrag.preview.under', { name }) : t('taskdrag.preview.own', { name })) : isMinion ? t('taskdrag.preview.hand', { name }) : t('taskdrag.refuse.belongs', { name: String(drag?.payload.meta?.ownerName ?? '') });
  return (
    <span className={`ck-adopt-over${refused ? ' is-refused' : ''}`} data-testid="task-drop-preview" data-adopt-target={paneId} data-where={where}>
      {text}
    </span>
  );
}
