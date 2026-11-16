import type { CockpitApi } from '../../hooks/useCockpit';
import { useT } from '../../i18n';
import { projectWithCopy } from './shell-labels';
import { stuckTitle, useLoopGuard, type LoopSignal } from '../../lib/loop-guard';
import { tauriStallApi, useStall, type StallApi } from '../../lib/stalls';
import { useStallActions, type StallAction } from './useStallActions';
import '../../styles/loop-guard.css';
import { CardButton, InboxCard } from './InboxCard';

/** Window event that opens the sidebar "+" menu (the Sidebar listens for it). */
export const OPEN_NEW_MENU = 'pm:open-new-menu';

export function focusTerminal(): void {
  window.setTimeout(() => {
    if (typeof document === 'undefined') return; // the window was torn down (tests, closing)
    const slot = document.querySelector<HTMLElement>('.ck-term-slot');
    (slot?.querySelector<HTMLElement>('[tabindex], textarea, canvas') ?? slot)?.focus();
  }, 60);
}

/**
 * An InboxCard: what looks wrong, the lines that show it, and the ways out. One card per helper: the loop guard's
 * signal (the same error again and again) and the stall (no progress for N minutes) are one card. With a stall it
 * offers Nudge, Stop and Respawn; with only a loop signal it offers a hint, Interrupt and Ask another agent.
 */
export function StuckCard({
  name,
  project,
  agent,
  signal,
  stall,
  onHint,
  onInterrupt,
  onAsk,
  onDismiss,
}: {
  name: string;
  project?: string;
  agent?: string | null;
  /** The loop guard's signal. Absent when the helper only has no progress. */
  signal?: LoopSignal;
  /** The helper has had no progress for `minutes`: Nudge, Stop and Respawn. */
  stall?: { paneId: string; minutes: number; api?: StallApi };
  onHint: () => void;
  onInterrupt: () => void;
  onAsk: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const { busy, note, run } = useStallActions(stall?.paneId ?? '', stall?.api ?? tauriStallApi);
  const evidence = signal?.evidence_lines ?? [];
  const stallButton = (which: StallAction, tone: 'primary' | 'secondary') => (
    <CardButton key={which} tone={tone} role={which === 'nudge' ? 'answer' : undefined} disabled={busy !== null} title={t(`stall.${which}Tip`)} onClick={() => void run(which)}>
      {t(`stall.${which}`)}
    </CardButton>
  );
  return (
    <InboxCard
      kind="stuck"
      agent={agent}
      glyph="needs"
      title={signal ? stuckTitle(name, signal) : t('inboxCards.stuck.stallTitle', { name, n: stall?.minutes ?? 0 })}
      meta={project}
      data={{ 'data-stuck': '', 'data-stalled': stall ? '' : undefined }}
      body={
        evidence.length > 0 || (signal && stall) || note ? (
          <>
            {signal && stall && <p className="ib-reason">{t('inboxCards.stuck.stallLine', { n: stall.minutes })}</p>}
            {evidence.length > 0 && (
              <ul className="ib-evidence">
                {evidence.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
            {note && (
              <p className="ib-reason" role="status">
                {note}
              </p>
            )}
          </>
        ) : null
      }
      actions={
        stall ? (
          <>
            {stallButton('nudge', 'primary')}
            {stallButton('stop', 'secondary')}
            {stallButton('respawn', 'secondary')}
          </>
        ) : (
          <>
            <CardButton tone="primary" role="answer" onClick={onHint}>
              {t('inboxCards.stuck.hint')}
            </CardButton>
            <CardButton tone="secondary" role="answer" onClick={onInterrupt}>
              {t('inboxCards.stuck.interrupt')}
            </CardButton>
            <CardButton tone="secondary" role="answer" onClick={onAsk}>
              {t('inboxCards.stuck.askAnother')}
            </CardButton>
          </>
        )
      }
      more={
        <>
          {signal && stall && (
            <>
              <CardButton tone="plain" onClick={onHint}>
                {t('inboxCards.stuck.hint')}
              </CardButton>
              <CardButton tone="plain" onClick={onAsk}>
                {t('inboxCards.stuck.askAnother')}
              </CardButton>
            </>
          )}
          {signal && (
            <CardButton tone="plain" role="dismiss" onClick={onDismiss}>
              {t('inboxCards.dismiss')}
            </CardButton>
          )}
        </>
      }
    />
  );
}

/**
 * The card for one pane, wired to the cockpit. Renders nothing when the pane is not stuck. `dock`
 * is for the pane view, which docks the card with its own margin; in the Inbox the list spaces it.
 */
export function PaneStuckCard({ c, paneId, dock = true, stallApi }: { c: CockpitApi; paneId: string; dock?: boolean; stallApi?: StallApi }) {
  const { signals, dismiss } = useLoopGuard();
  const signal = signals[paneId];
  // The pane's own view already shows the stall notice above its composer, so only the Inbox card carries the stall.
  const stalledMin = useStall(paneId);
  const minutes = dock ? null : stalledMin;
  if (!signal && minutes === null) return null;
  const name = c.names.get(paneId) ?? paneId;
  const info = c.registry.paneList.find((p) => p.info.id === paneId)?.info;
  const cwd = info?.cwd;
  const card = (
    <StuckCard
      name={name}
      project={cwd ? projectWithCopy(cwd) : undefined}
      agent={info?.agent_type}
      signal={signal}
      stall={minutes === null ? undefined : { paneId, minutes, api: stallApi }}
      onHint={() => {
        if (c.selectedId !== paneId) c.select(paneId);
        focusTerminal();
      }}
      onInterrupt={() => void c.interrupt(paneId)}
      onAsk={() => window.dispatchEvent(new CustomEvent(OPEN_NEW_MENU))}
      onDismiss={() => dismiss(paneId)}
    />
  );
  return dock ? <div className="ib-dock">{card}</div> : card;
}
