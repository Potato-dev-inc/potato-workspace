// The ready-made crews as cards (the three starters and the templates, "How we work" among them). Shown on the Crews page, and
// first when there is no saved crew yet. "Look at it" opens one on the canvas, read-only, where "Save my own copy" makes it yours.
import { useT } from '../../i18n';
import type { CrewSummary } from '../../lib/crews-api';

/** Slugs the app ships a one-line description for. */
const ABOUT = new Set(['template:how-we-work', 'template:our-way', 'starter:builder-reviewer', 'starter:fix-the-tests', 'starter:research-write']);

export function CrewGallery({ crews, empty, onLook }: { crews: CrewSummary[]; empty: boolean; onLook: (slug: string) => void }) {
  const t = useT();
  if (crews.length === 0) return null;
  return (
    <>
      <h4 className="crews-sub">{t('crewcanvas.page.ready')}</h4>
      {empty ? <p className="crews-note">{t('crewgallery.empty')}</p> : null}
      <ul className="crews-gallery" aria-label={t('crewcanvas.page.ready')} data-testid="crew-gallery">
        {crews.map((crew) => (
          <li key={crew.slug} className="crews-card" data-testid="crew-card">
            <span className="crews-row-name">{crew.name}</span>
            {ABOUT.has(crew.slug) ? <span className="crews-card-about">{t(`crewgallery.about.${crew.slug}` as never)}</span> : null}
            <span className="crews-row-meta">{t('crews.page.roles', { count: crew.roles })}</span>
            {crew.problem ? <span className="crews-row-problem">{t('crews.page.problem', { why: crew.problem })}</span> : null}
            <button type="button" className="crews-open" onClick={() => onLook(crew.slug)}>
              {t('crewcanvas.page.look')}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
