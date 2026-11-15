// "Leaving my desk" on the PC: the chip in the status bar, the sheet that asks how long, and the banner that says
// "Away · phone has control" with "I'm back". The PC's rules do the work (`mobile_pairing::desk_away`); this only asks and shows.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage, useT } from '../../i18n';
import {
  DESK_LENGTHS,
  isAway,
  openDeskSheet,
  readLockChoice,
  setDeskSheetOpen,
  useDeskAway,
  useDeskSheetOpen,
  writeLockChoice,
  type DeskLength,
  type DeskStore,
} from '../../lib/desk-away';
import { useDismissable } from '../../hooks/useDismissable';
import '../../styles/desk-away.css';

/** The small button in the status bar. Shown only when a phone is paired and the switch is off (the banner is the on state). */
export function DeskAwayChip({ store }: { store?: DeskStore }) {
  const t = useT();
  const [state] = useDeskAway(store);
  if (state.phones === 0 || isAway(state)) return null;
  return (
    <button type="button" className="ck-sb-count ck-desk-chip" onClick={openDeskSheet} data-testid="desk-chip">
      {t('desk.chip')}
    </button>
  );
}

function clock(at: number, lang: string): string {
  return new Date(at).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });
}

/** The sheet (how long, lock the screen features, start) and, while the switch is on, the banner with "I'm back". */
export function DeskAwayHost({ store }: { store?: DeskStore }) {
  const t = useT();
  const lang = useLanguage();
  const [state, deskStore] = useDeskAway(store);
  const sheetOpen = useDeskSheetOpen();
  const [length, setLength] = useState<DeskLength>('until_back');
  const [lock, setLock] = useState(readLockChoice);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const away = isAway(state);

  useEffect(() => {
    if (sheetOpen) sheet.current?.querySelector<HTMLElement>('input')?.focus();
  }, [sheetOpen]);
  useDismissable(sheetOpen, { inside: [sheet], ignore: ['blur', 'focus'], onDismiss: () => setDeskSheetOpen(false) });

  const start = async () => {
    setBusy(true);
    setFailed(false);
    try {
      writeLockChoice(lock);
      await deskStore.start(length, lock);
      setDeskSheetOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const back = async () => {
    setFailed(false);
    try {
      await deskStore.back();
    } catch {
      setFailed(true);
    }
  };

  const host = document.querySelector('.cockpit') ?? document.body;
  const until = state.until_ms == null ? t('desk.untilBack') : t('desk.until', { time: clock(state.until_ms, lang) });
  return (
    <>
      {away && (
        <div className="ck-desk-banner" role="status" data-testid="desk-banner">
          <div className="ck-desk-banner-text">
            <b>{state.by === 'phone' ? t('desk.awayPhone') : t('desk.away')}</b>
            <span>{[until, state.lock_screen ? t('desk.locked') : null].filter(Boolean).join(' · ')}</span>
          </div>
          <button type="button" className="ck-desk-back" onClick={() => void back()} data-testid="desk-back">
            {t('desk.back')}
          </button>
          {failed && (
            <span className="ck-desk-err" role="alert">
              {t('desk.failed')}
            </span>
          )}
        </div>
      )}
      {sheetOpen &&
        !away &&
        createPortal(
          <div ref={sheet} className="ck-desk-sheet" role="dialog" aria-label={t('desk.title')} data-testid="desk-sheet">
            <p className="ck-desk-title">{t('desk.title')}</p>
            <p className="ck-desk-note">{t('desk.intro')}</p>
            <fieldset className="ck-desk-lengths">
              <legend>{t('desk.how')}</legend>
              {DESK_LENGTHS.map((l) => (
                <label key={l}>
                  <input type="radio" name="desk-length" checked={length === l} onChange={() => setLength(l)} />
                  <span>{t(`desk.len.${l}`)}</span>
                </label>
              ))}
            </fieldset>
            <label className="ck-desk-lock">
              <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
              <span>
                {t('desk.lock')}
                <small>{t('desk.lockHint')}</small>
              </span>
            </label>
            <p className="ck-desk-note">{t('desk.push')}</p>
            {state.phones === 0 && (
              <p className="ck-desk-note" role="status">
                {t('desk.noPhone')}
              </p>
            )}
            {failed && (
              <p className="ck-desk-err" role="alert">
                {t('desk.failed')}
              </p>
            )}
            <div className="ck-desk-actions">
              <button type="button" onClick={() => setDeskSheetOpen(false)}>
                {t('desk.cancel')}
              </button>
              <button type="button" className="ck-desk-go" onClick={() => void start()} disabled={busy || state.phones === 0} data-testid="desk-start">
                {t('desk.start')}
              </button>
            </div>
          </div>,
          host,
        )}
    </>
  );
}
