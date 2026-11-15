import { useT } from '../../i18n';

/** Shelf: skills, tools and prompts the team shares. Not built yet: one honest line, no sample data. */
export function ShelfTab() {
  const t = useT();
  return (
    <section className="tpg-card" data-testid="shelf-empty">
      <h3 className="tpg-h">{t('teamHub.shelf.title')}</h3>
      <p className="tpg-sub">{t('teamHub.shelf.empty')}</p>
    </section>
  );
}
