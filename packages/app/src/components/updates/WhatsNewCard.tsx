// "What is new": shown once after an update restarted the app. It reads the note the update left behind (version, three
// lines of the changelog, how many chats were open) and removes it at once. When the app bundles highlights for that
// version it is the small animated card that offers the tour (it never blocks work); otherwise it is the plain list.
// Closing the card (Not now, X) or opening the tour marks the version as seen, so it shows once per version.
import { useEffect, useState } from 'react';
import { tauriUpdateTransport, type UpdateTransport } from '../../lib/app-update';
import { takeWhatsNew, whatsNewLines, type WhatsNewNote } from '../../lib/update-schedule';
import { useT } from '../../i18n';
import { Demo } from '../../whatsnew/demos';
import { hasTour, lineOf, normalVersion, titleOf, tourOf } from '../../whatsnew/catalog';
import { useCatalogFilter, usePrefersReducedMotion } from '../../whatsnew/hooks';
import { isSeen, markSeen, openTour, setRunningVersion } from '../../whatsnew/store';
import '../../styles/app-update.css';
import '../../styles/whatsnew.css';

export function WhatsNewCard({ transport = tauriUpdateTransport, suppressed = false, notify }: { transport?: UpdateTransport; suppressed?: boolean; notify?: (text: string) => void }) {
  const t = useT();
  const filter = useCatalogFilter();
  const reduced = usePrefersReducedMotion();
  const [running, setRunning] = useState<string | null>(null);
  const [note, setNote] = useState<WhatsNewNote | null>(null);

  useEffect(() => {
    let alive = true;
    void (transport.currentVersion?.() ?? Promise.resolve(null))
      .then((v) => {
        if (!alive) return;
        setRunning(v);
        setRunningVersion(v);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [transport]);

  // The note is taken once the running version is known, and not while the first-run screens are open (it waits).
  useEffect(() => {
    if (!running || suppressed) return;
    const taken = takeWhatsNew(running);
    // Already seen (the tour was opened, or the card closed, before): nothing to show.
    if (taken && !isSeen(taken.version)) setNote(taken);
  }, [running, suppressed]);

  if (!note) return null;
  const cards = tourOf(note.version, filter);
  const lines = whatsNewLines(note.notes);
  const title = t('flow.whatsNew.title', { version: note.version });
  const chats = note.chats > 0 ? <span>{t('flow.whatsNew.chatsBack', { count: note.chats })}</span> : null;

  // No highlights for this version: today's plain list (no tour button).
  if (cards.length === 0) {
    return (
      <section className="app-whatsnew" role="status" aria-label={title} data-testid="whats-new-card">
        <strong>{title}</strong>
        {lines.length > 0 && (
          <ul>
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {chats}
        <button
          type="button"
          className="app-update-btn"
          onClick={() => {
            markSeen(note.version);
            setNote(null);
          }}
        >
          {t('flow.whatsNew.close')}
        </button>
      </section>
    );
  }

  const first = cards[0];
  const later = () => {
    markSeen(note.version);
    setNote(null);
    notify?.(t('whatsnew.findLater'));
  };
  const open = () => {
    setNote(null);
    openTour(normalVersion(note.version));
  };
  return (
    <section className="wn-upcard" role="status" aria-label={title} data-testid="whats-new-card" data-mode="highlights">
      <div className="wn-uphd">
        <b>{t('whatsnew.updatedTo', { version: note.version })}</b>
        {hasTour(note.version, filter) && <span className="wn-newtag">{t('whatsnew.newThings', { count: cards.length })}</span>}
        <button type="button" className="wn-upx" aria-label={t('flow.whatsNew.close')} onClick={later}>
          ×
        </button>
      </div>
      <Demo name={first.demo} area={first.area} play={!reduced} />
      <p>{cards.length > 1 ? t('whatsnew.cardLine', { first: titleOf(first), count: cards.length - 1 }) : lineOf(first)}</p>
      <div className="wn-upr">
        {hasTour(note.version, filter) && (
          <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" onClick={open}>
            {t('whatsnew.see')}
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={later}>
          {t('whatsnew.notNow')}
        </button>
      </div>
      {chats}
    </section>
  );
}
