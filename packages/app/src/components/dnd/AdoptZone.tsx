// A main agent's row in the sidebar as a place to drop another agent: "Make helper of <name>". Only the middle half of the
// row takes the drop; the top and bottom quarters stay the place where a chat is dragged into a new order. While the pointer is
// over it the row shows what would happen (or why it cannot). Mount one inside each main agent's `.ck-rowwrap`: it measures its
// parent, so the row needs no other change.
import { useEffect, useRef } from 'react';
import '../../styles/cockpit-adopt.css';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { registerDropZone, useDrag, useDragOver } from './dragStore';

export interface AdoptZoneProps {
  paneId: string;
  /** The shown name of this agent. */
  name: string;
  /** Why `childId` cannot become a helper of this agent (a message key), or null when it can. */
  refusal: (childId: string) => MessageKey | null;
  /** The drop: `childId` was let go on this agent. */
  onAdopt: (childId: string, parentId: string) => void;
}

/** The share of the row's height, top and bottom, that is left to reordering. */
export const EDGE_SHARE = 0.25;

export function AdoptZone({ paneId, name, refusal, onAdopt }: AdoptZoneProps) {
  const mark = useRef<HTMLSpanElement>(null);
  const live = useRef({ onAdopt });
  live.current = { onAdopt };
  const zoneId = `adopt-${paneId}`;
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
