// The Night Shift chip at the bottom of the sidebar (SPEC n32 3.10.2). One dense row while a run exists:
// running (dot spinner), waiting for a plan, scheduled, or finished (opens Morning). A running chip opens a
// small popover with the tasks and Stop; Stop asks once more before it stops anything. Labs off or no run: nothing.
import { useEffect, useRef, useState } from 'react';
import { nightApi, nightErrorText, useNight, type NightStateView, type NightTaskView } from '../../../lib/night';
import { t as tr, useT } from '../../../i18n';
import { DotSpinner } from '../DotSpinner';
import '../../../styles/night-chip.css';

export type ChipKind = 'running' | 'waiting' | 'scheduled' | 'finished';

export interface ChipView {
  kind: ChipKind;
  /** The words after the name: "3 of 5 until 07:00", "Starts 23:30", "4 of 5 done". */
  text: string;
  /** Tasks that need the person. The chip shows "+ N" when it is more than 0. */
  needsYou: number;
  /** Stop is offered while the run is not finished (running, waiting or scheduled). */
  canStop: boolean;
}

/** What the chip says for a state, or null when it is hidden (Labs off or no run). Pure, for the tests. */
export function chipView(state: NightStateView | null): ChipView | null {
  const run = state?.run;
  if (!state?.enabled || !run) return null;
  const needsYou = run.needsYou;
  if (run.state === 'done' || run.state === 'stopped') {
    return { kind: 'finished', text: tr('state.night.done', { done: run.done, total: run.total }), needsYou, canStop: false };
  }
  if (run.state === 'scheduled') {
    return { kind: 'scheduled', text: tr('state.night.starts', { from: run.from }), needsYou, canStop: true };
  }
  const waiting = run.tasks.find((task) => task.state === 'waiting');
  if (waiting) {
    const plan = waiting.plan ?? tr('state.night.aPlan');
    const text = waiting.until ? tr('state.night.waitingUntil', { plan, until: waiting.until }) : tr('state.night.waitingFor', { plan });
    return { kind: 'waiting', text, needsYou, canStop: true };
  }
  return { kind: 'running', text: tr('state.night.running', { done: run.done, total: run.total, until: state.settings.stopHhmm }), needsYou, canStop: true };
}

/** The glyph of one task in the popover: `~` working, `:` waiting, `-` queued, then `v` ready, `+` needs a look, `x` the rest. */
export function taskGlyph(task: NightTaskView): string {
  if (task.state === 'working') return '~';
  if (task.state === 'waiting') return ':';
  if (task.state === 'queued') return '-';
  if (task.class === 'ready' || task.class === 'no_checks') return 'v';
  if (task.class === 'needs_look') return '+';
  return 'x';
}

export function NightChip({ onOpenMorning }: { onOpenMorning: () => void }) {
  const t = useT();
  const { state, reload } = useNight();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const view = chipView(state);
  const run = state?.run;
  if (!view || !run) return null;

  const finished = view.kind === 'finished';

  const toggle = () => {
    setConfirming(false);
    setStopError(null);
    setOpen((v) => !v);
  };
  const askStop = () => {
    setOpen(true);
    setConfirming(true);
    setStopError(null);
  };
  const cancelStop = () => {
    setConfirming(false);
    setStopError(null);
  };
  const stop = () => {
    setBusy(true);
    setStopError(null);
    nightApi
      .stop()
      .then(() => {
        setOpen(false);
        setConfirming(false);
        return reload();
      })
      .catch((err) => setStopError(nightErrorText(err)))
      .finally(() => setBusy(false));
  };

  const glyph = view.kind === 'running' ? <DotSpinner status="running" /> : <span className="ck-night-glyph" aria-hidden="true">{finished ? 'v' : ':'}</span>;

  return (
    <div className="ck-night-wrap" ref={wrap}>
      <div className={`ck-night-chip is-${view.kind}`} data-testid="night-chip">
        <button
          type="button"
          className="ck-night-chip-main"
          aria-haspopup={finished ? undefined : 'dialog'}
          aria-expanded={finished ? undefined : open}
          onClick={finished ? onOpenMorning : toggle}
        >
          {glyph}
          <span className="ck-night-name">{t('state.night.name')}</span>
          <span className="ck-night-detail">{view.text}</span>
          {view.needsYou > 0 && (
            <span className="ck-chip-count ck-night-more" title={t('state.night.needYou', { n: view.needsYou })}>{`+ ${view.needsYou}`}</span>
          )}
          {finished && <span className="ck-night-open">{t('state.night.openMorning')}</span>}
        </button>
        {view.canStop && (
          <button type="button" className="ck-btn ck-btn--plain ck-night-stop" onClick={askStop}>
            {t('state.night.stop')}
          </button>
        )}
      </div>
      {open && !finished && (
        <div className="ck-night-chip-pop" role="dialog" aria-label={t('state.night.name')} data-testid="night-popover">
          <div className="ck-night-chip-pop-head">
            <span className="ck-night-chip-pop-title">{t('state.night.name')}</span>
            <span className="ck-night-chip-pop-line">{run.line}</span>
          </div>
          <ul className="ck-night-tasks">
            {run.tasks.map((task) => (
              <li className="ck-night-task" key={task.id}>
                <span className="ck-night-glyph" aria-hidden="true">{taskGlyph(task)}</span>
                <span className="ck-night-task-title">{task.title}</span>
                <span className="ck-night-task-meta">{[task.plan, task.duration].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
          {view.canStop &&
            (confirming ? (
              <div className="ck-night-confirm">
                <p className="ck-night-note">{t('state.night.stopNote')}</p>
                <div className="ck-night-actions">
                  <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" disabled={busy} onClick={stop}>
                    {t('state.night.stopNight')}
                  </button>
                  <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={cancelStop}>
                    {t('state.night.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="ck-night-actions">
                <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={() => setConfirming(true)}>
                  {t('state.night.stopNight')}
                </button>
              </div>
            ))}
          {stopError && (
            <p role="alert" className="ck-night-error">
              {stopError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
