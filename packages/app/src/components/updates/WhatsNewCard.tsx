// "What is new": shown once after an update restarted the app. It reads the note the update left behind
// (version, three lines of the changelog, how many chats were open) and removes it at once.
import { useEffect, useState } from 'react';
import { tauriUpdateTransport, type UpdateTransport } from '../../lib/app-update';
import { takeWhatsNew, whatsNewLines, type WhatsNewNote } from '../../lib/update-schedule';
import { useT } from '../../i18n';
import '../../styles/app-update.css';

export function WhatsNewCard({ transport = tauriUpdateTransport }: { transport?: UpdateTransport }) {
  const t = useT();
  const [note, setNote] = useState<WhatsNewNote | null>(null);
  useEffect(() => {
    let alive = true;
    void (transport.currentVersion?.() ?? Promise.resolve(null))
      .then((running) => {
        if (alive) setNote(takeWhatsNew(running));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [transport]);
  if (!note) return null;
  const lines = whatsNewLines(note.notes);
  return (
    <section className="app-whatsnew" role="status" aria-label={t('flow.whatsNew.title', { version: note.version })} data-testid="whats-new-card">
      <strong>{t('flow.whatsNew.title', { version: note.version })}</strong>
      {lines.length > 0 && (
        <ul>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {note.chats > 0 && <span>{t('flow.whatsNew.chatsBack', { count: note.chats })}</span>}
      <button type="button" className="app-update-btn" onClick={() => setNote(null)}>
        {t('flow.whatsNew.close')}
      </button>
    </section>
  );
}
