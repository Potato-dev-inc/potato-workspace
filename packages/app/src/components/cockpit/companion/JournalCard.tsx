// The companion's journal (Labs: companion vault): the latest diary, the last two days, and the people it knows.
// Desktop only. If the transport has no journal or it fails, the card says "Nothing here yet." and nothing breaks.
import { useEffect, useState } from 'react';
import type { CompanionTransport, JournalView } from '../../../lib/companion';
import { useT } from '../../../i18n';

export function JournalCard({
  companionId,
  name,
  transport,
  refreshKey,
}: {
  companionId: string;
  name: string;
  transport: CompanionTransport;
  /** Changes when the companion changes state, so the journal is read again. */
  refreshKey?: string;
}) {
  const t = useT();
  const [journal, setJournal] = useState<JournalView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [diaryOpen, setDiaryOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const has = typeof transport.journal === 'function';

  useEffect(() => {
    if (!transport.journal) return;
    let live = true;
    transport
      .journal(companionId)
      .then((next) => {
        if (live) setJournal(next);
      })
      .catch(() => {
        if (live) setJournal(null);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [transport, companionId, refreshKey]);

  if (!has) return null;
  const days = [...(journal?.days ?? [])]
    .filter((d) => d.lines.length > 0)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 2);
  const diary = journal?.diary?.text.trim() ? journal.diary : null;
  const people = journal?.people ?? [];
  const empty = !diary && days.length === 0 && people.length === 0;

  return (
    <section className="ck-companion-card" aria-labelledby="ck-companion-journal-title">
      <h2 className="ck-companion-card-title" id="ck-companion-journal-title">
        {t('companion.journal.title', { name })}
      </h2>
      {!loaded ? null : empty ? (
        <p className="ck-sub">{t('companion.journal.empty')}</p>
      ) : (
        <>
          {diary && (
            <div className="ck-journal-block">
              <h3 className="ck-body-sub">
                {t('companion.journal.diary')} <span className="ck-journal-date">{diary.date}</span>
              </h3>
              <p className={`ck-journal-diary${diaryOpen ? '' : ' is-clamped'}`}>{diary.text}</p>
              <button type="button" className="ck-btn ck-btn--sm ck-btn--plain ck-journal-toggle" aria-expanded={diaryOpen} onClick={() => setDiaryOpen((v) => !v)}>
                {diaryOpen ? t('companion.journal.showLess') : t('companion.journal.showMore')}
              </button>
            </div>
          )}
          {days.length > 0 && (
            <div className="ck-journal-block">
              <h3 className="ck-body-sub">{t('companion.journal.days')}</h3>
              {days.map((day) => (
                <div className="ck-journal-day" key={day.date}>
                  <span className="ck-journal-date">{day.date}</span>
                  <ul className={`ck-journal-lines${daysOpen ? '' : ' is-clamped'}`}>
                    {day.lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <button type="button" className="ck-btn ck-btn--sm ck-btn--plain ck-journal-toggle" aria-expanded={daysOpen} onClick={() => setDaysOpen((v) => !v)}>
                {daysOpen ? t('companion.journal.showLess') : t('companion.journal.showMore')}
              </button>
            </div>
          )}
          <div className="ck-journal-block">
            <h3 className="ck-body-sub">{t('companion.journal.people')}</h3>
            {people.length > 0 ? (
              <p className="ck-journal-people">{people.map((p) => p.name).join(', ')}</p>
            ) : (
              <p className="ck-sub">{t('companion.journal.noPeople')}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
