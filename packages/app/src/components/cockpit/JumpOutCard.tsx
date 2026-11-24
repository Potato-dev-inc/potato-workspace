// A small card that jumps out over the work area when an agent is blocked on a question that only the Inbox shows
// (the helper-login card above all). It NEVER takes the keyboard: no autoFocus, no document-level listener, a polite live
// region. "Later" only hides it here; the question stays in the Inbox and counts as before. The rules are in lib/jump-out.ts.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { pageZoom } from '../common/Floating';
import type { CockpitApi } from '../../hooks/useCockpit';
import { FarNeedsContext, useNeedsYou, type FarNeeds } from '../../hooks/useNeedsYou';
import { jumpOutLayout, pickJumpOut, type JumpEntry } from '../../lib/jump-out';
import { useJumpOutEnabled } from '../../lib/jump-out-setting';
import { isSnoozedKey } from '../../lib/notify-store';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { asQuestion } from '../../lib/runtime/farQuestions';
import { errorSentence } from '../../lib/sayError';
import type { QuestionAnswer } from '../../lib/questions';
import { CardButton } from './InboxCard';
import { BudgetCard } from './BudgetCard';
import { ConsentCard } from './ConsentCard';
import { PaneApprovalCard } from './PaneApprovalCard';
import { QuestionCard } from './QuestionCard';
import '../../styles/inbox-card.css';

/** Where the card belongs: above the chat's message box (or the new-agent page's). */
const COMPOSERS = '.ck-chat-composer, .ck-na-composer';

/** True while the person is in the card: focus inside it, or text typed into one of its fields. */
function inUse(box: HTMLElement | null): boolean {
  if (!box) return false;
  if (box.contains(document.activeElement) && document.activeElement !== box) return true;
  return Array.from(box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]), textarea')).some((f) => f.value !== '');
}

export function JumpOutCard({
  c,
  view,
  shown,
  farOpen,
  onOpenInbox,
}: {
  c: CockpitApi;
  /** The cockpit's main view (`inbox`, `pane`, ...). */
  view: string;
  /** The panes the main window shows right now. */
  shown: readonly string[];
  /** The far chat that is open, if any. */
  farOpen: { node: string; paneId: string } | null;
  onOpenInbox: () => void;
}) {
  const t = useT();
  const needs = useNeedsYou(c);
  const farNeeds = useContext(FarNeedsContext);
  const enabled = useJumpOutEnabled();
  // What "Later" hid, by occurrence key. Session only; never touches the question itself.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [, recheck] = useState(0);
  const firstSeen = useRef(new Map<string, number>());
  const box = useRef<HTMLDivElement>(null);
  const shownKey = useRef<string | null>(null);

  const now = Date.now();
  const ids = new Set(needs.map((n) => n.id));
  for (const id of ids) if (!firstSeen.current.has(id)) firstSeen.current.set(id, now);
  for (const id of [...firstSeen.current.keys()]) if (!ids.has(id)) firstSeen.current.delete(id);

  const pick = pickJumpOut({
    needs,
    questions: c.asked.questions,
    far: farNeeds?.questions ?? [],
    panes: c.registry.paneList,
    promptIds: Object.fromEntries(Object.entries(c.prompts).map(([pane, p]) => [pane, p?.promptId])),
    view,
    mode: c.mode,
    enabled,
    shown,
    farOpen,
    hidden,
    isSnoozed: (keys) => isSnoozedKey(keys, now),
    firstSeen: firstSeen.current,
    now,
  });

  // The card stays while the person is in it, even when a first-in-line card arrives.
  const keep = shownKey.current !== null && inUse(box.current) ? pick.ready.find((e) => e.key === shownKey.current) : undefined;
  const entry = keep ?? pick.entry;
  const more = pick.ready.length - (entry ? 1 : 0);
  shownKey.current = entry?.key ?? null;

  // Forget "Later" for items that are gone, so a question that comes back (a new one) is not hidden.
  const live = pick.liveKeys.join('\n');
  useEffect(() => {
    setHidden((prev) => {
      const keys = new Set(live.split('\n'));
      const next = new Set([...prev].filter((k) => keys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [live]);

  // A new item shows after its grace: look again then.
  useEffect(() => {
    if (pick.waitMs === null) return;
    const timer = window.setTimeout(() => recheck((n) => n + 1), pick.waitMs + 50);
    return () => window.clearTimeout(timer);
  }, [pick.waitMs]);

  // Keep clear of the message box and the panels beside the chat: sit in the chat column, right above its message box.
  // Window pixels (rects) are `zoom` times the CSS pixels a layer is placed in (Text size), so everything is divided by it.
  // Sizes alone are not enough to watch (a panel can move without resizing, a slide-in starts offset), so it also looks again
  // on a slow tick. CSS falls back to fixed offsets when there is no message box (Inbox, terminal).
  const shownEntry = entry?.key;
  const [tight, setTight] = useState(false);
  // A column too narrow to hold the card: only the line, and Show opens the Inbox (the card would have to cover the sidebar).
  const [narrow, setNarrow] = useState(false);
  // Narrower still: a dot, Show and Later as icons on one row; below a hard floor the card is not drawn at all.
  const [mini, setMini] = useState(false);
  const [gone, setGone] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [shownEntry]);
  useLayoutEffect(() => {
    const el = box.current;
    const stage = el?.closest('.cockpit');
    if (!el || !stage) return;
    const place = () => {
      const z = pageZoom();
      const s = (el.offsetParent ?? stage).getBoundingClientRect();
      const set = (k: string, v: number | null) => (v === null ? el.style.removeProperty(k) : el.style.setProperty(k, `${Math.round(v)}px`));
      // The rightmost message box is the column the card belongs to (split chats have several).
      const comps = Array.from(stage.querySelectorAll(COMPOSERS), (n) => n.getBoundingClientRect()).filter((r) => r.height > 0 && r.width > 0);
      const comp = comps.reduce<DOMRect | undefined>((a, r) => (!a || r.right > a.right ? r : a), undefined);
      if (comp) {
        const room = (comp.top - s.top) / z - 16;
        // The column is what the chat really has: its left edge is never left of the sidebar (a panel can lie over the chat's edge).
        const side = stage.querySelector('.ck-side')?.getBoundingClientRect();
        const colLeft = side && side.width > 0 ? Math.max(comp.left, side.right) : comp.left;
        const colWidth = (comp.right - colLeft) / z;
        const edgeLeft = (colLeft - s.left) / z + 16;
        const { width, narrow: isNarrow, tight: isTight, mini: isMini, gone: isGone } = jumpOutLayout(colWidth, room);
        set('--jo-bottom', (s.bottom - comp.top) / z + 8);
        // Right edge 16px inside the column; pushed right only if the column is too small for the card to stay right of the sidebar.
        set('--jo-right', s.width / z - Math.max((comp.right - s.left) / z - 16, edgeLeft + width));
        set('--jo-max', room);
        set('--jo-col', width);
        setNarrow(isNarrow);
        setTight(isTight);
        setMini(isMini);
        setGone(isGone);
        return;
      }
      const rail = stage.querySelector('.ck-rail')?.getBoundingClientRect();
      set('--jo-bottom', null);
      set('--jo-max', null);
      set('--jo-col', null);
      set('--jo-right', rail && rail.width > 0 ? (s.right - rail.left) / z + 16 : null);
      setNarrow(false);
      setTight(false);
      setMini(false);
      setGone(false);
    };
    place();
    const tick = window.setInterval(place, 400);
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    watch?.observe(stage);
    for (const n of stage.querySelectorAll(`${COMPOSERS}, .ck-rail`)) watch?.observe(n);
    return () => {
      window.clearInterval(tick);
      watch?.disconnect();
    };
  }, [shownEntry, view]);

  if (!entry) return null;
  const later = () => setHidden((prev) => new Set(prev).add(entry.key));
  // Not enough room above the message box for the whole card: one line, and the card on request.
  const compact = tight && !open;
  const region = t('inboxCards.jumpOut.region');
  if (mini) {
    return (
      <div ref={box} className="ck-jumpout" data-mini hidden={gone} role="region" aria-live="polite" aria-label={region} data-jump-key={entry.key}>
        <div className="ck-jumpout-line">
          <span className="ck-jumpout-dot" role="img" aria-label={region} />
          <CardButton tone="plain" size="sm" aria-label={t('inboxCards.jumpOut.show')} title={t('inboxCards.jumpOut.show')} onClick={onOpenInbox}>
            {'›'}
          </CardButton>
          <CardButton tone="plain" size="sm" aria-label={t('inboxCards.jumpOut.later')} title={t('inboxCards.jumpOut.laterTip')} onClick={later}>
            {'×'}
          </CardButton>
        </div>
      </div>
    );
  }
  return (
    <div ref={box} className="ck-jumpout" data-compact={compact || undefined} data-narrow={narrow || undefined} role="region" aria-live="polite" aria-label={t('inboxCards.jumpOut.region')} data-jump-key={entry.key}>
      {compact ? (
        <div className="ck-jumpout-line">
          <span className="ck-jumpout-text">{t('inboxCards.jumpOut.region')}</span>
          <CardButton tone="plain" size="sm" onClick={() => (narrow ? onOpenInbox() : setOpen(true))}>
            {t('inboxCards.jumpOut.show')}
          </CardButton>
        </div>
      ) : (
        <div className="ib-dock" key={entry.key}>
          {cardOf(entry, c, farNeeds, t)}
        </div>
      )}
      <div className="ck-jumpout-foot">
        <CardButton tone="plain" size="sm" title={t('inboxCards.jumpOut.laterTip')} onClick={later}>
          {t('inboxCards.jumpOut.later')}
        </CardButton>
        {more > 0 && (
          <CardButton tone="plain" size="sm" onClick={onOpenInbox}>
            {t('inboxCards.jumpOut.more', { n: more })}
          </CardButton>
        )}
      </div>
    </div>
  );
}

/** The Inbox's own card for the entry, answering by the Inbox's own route. No Dismiss: that would cancel the question. */
function cardOf(entry: JumpEntry, c: CockpitApi, farNeeds: FarNeeds | null, t: ReturnType<typeof useT>) {
  const open = (paneId?: string) => (paneId && c.registry.panes.has(paneId) ? () => c.select(paneId) : undefined);
  const q = entry.question;
  if (entry.far) {
    const far = entry.far;
    return (
      <QuestionCard
        q={asQuestion(far, t('inbox.onHost', { name: far.pcName || t('inbox.onAnotherComputer') }))}
        now={c.now}
        onAnswer={(a) => void farNeeds?.answer(far.key, a).catch((e: unknown) => c.notify(errorSentence(e)))}
      />
    );
  }
  if (entry.kind === 'approval' && entry.paneId) {
    const paneId = entry.paneId;
    return <PaneApprovalCard c={c} paneId={paneId} autoFocus={false} hints={false} onOpen={() => c.select(paneId)} />;
  }
  if (!q) return null;
  const qPane = q.consent?.pane_id ?? q.pane_id;
  const paneName = qPane ? c.names.get(qPane) : undefined;
  const answer = (a: QuestionAnswer) => void c.asked.answerQuestion(q.id, a);
  if (entry.kind === 'consent') return <ConsentCard q={q} paneName={paneName} now={c.now} autoFocus={false} onAnswer={answer} onOpenPane={open(q.consent?.pane_id)} />;
  if (entry.kind === 'budget') return <BudgetCard q={q} paneName={paneName} now={c.now} onAnswer={answer} onOpenPane={open(q.pane_id)} />;
  return <QuestionCard q={q} paneName={paneName} now={c.now} onAnswer={answer} onOpenPane={open(q.pane_id)} onAddLogin={() => openSettingsAt('agents', 'accounts')} />;
}
