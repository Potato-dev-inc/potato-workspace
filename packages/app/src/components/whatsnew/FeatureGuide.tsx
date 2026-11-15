// The Feature guide: every feature with the same short demo as the tour. Cards are still until pointed at or focused,
// so a page of demos stays calm. Search filters on title + line. "Try it" runs the highlight's action.
import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { Demo } from '../../whatsnew/demos';
import { guideEntries, latestVersion, lineOf, normalVersion, titleOf, tryOf } from '../../whatsnew/catalog';
import { runAction } from '../../whatsnew/registry';
import { openTour, whatsNewVersion } from '../../whatsnew/store';
import { useCatalogFilter, usePrefersReducedMotion } from '../../whatsnew/hooks';
import { AREAS, type Highlight } from '../../whatsnew/types';
import '../../styles/whatsnew.css';

export function FeatureGuide({ notify }: { notify?: (text: string) => void }) {
  const t = useT();
  const filter = useCatalogFilter();
  const reduced = usePrefersReducedMotion();
  const [query, setQuery] = useState('');
  const [hot, setHot] = useState<string | null>(null);
  const version = normalVersion(whatsNewVersion()) || latestVersion();
  const entries = useMemo(() => guideEntries(filter), [filter.labOn, filter.platform]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = query.trim().toLowerCase();
  const shown = entries.filter((h) => !q || `${titleOf(h)} ${lineOf(h)}`.toLowerCase().includes(q));

  const tryIt = (h: Highlight) => {
    if (runAction(h.try.action, h.try.args ?? {}) === 'missing') notify?.(t('whatsnew.tryMissing'));
  };

  return (
    <div className="wn-guide" data-testid="feature-guide">
      <header className="wn-ghead">
        <h1 className="ck-title">{t('whatsnew.guideTitle')}</h1>
        <span className="wn-sp" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('whatsnew.search')} aria-label={t('whatsnew.search')} />
        <button type="button" className="ck-btn ck-btn--secondary" onClick={() => openTour(version)}>
          {t('whatsnew.whatsNewIn', { version })}
        </button>
      </header>
      <p className="wn-gsub">{t('whatsnew.guideSub')}</p>
      {shown.length === 0 && <p className="wn-gsub">{t('whatsnew.noMatch')}</p>}
      {AREAS.map((area) => {
        const items = shown.filter((h) => h.area === area);
        if (items.length === 0) return null;
        return (
          <section key={area} aria-label={t(`whatsnew.area.${area}` as 'whatsnew.area.Chat')}>
            <h2 className="wn-garea">{t(`whatsnew.area.${area}` as 'whatsnew.area.Chat')}</h2>
            <div className="wn-grid">
              {items.map((h) => (
                <article
                  key={h.id}
                  className="wn-gcard"
                  data-id={h.id}
                  tabIndex={0}
                  onPointerEnter={() => setHot(h.id)}
                  onPointerLeave={() => setHot((x) => (x === h.id ? null : x))}
                  onFocus={() => setHot(h.id)}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHot((x) => (x === h.id ? null : x));
                  }}
                >
                  <Demo name={h.demo} area={h.area} play={hot === h.id && !reduced} />
                  <h3>
                    {titleOf(h)}
                    {normalVersion(h.since) === version && <span className="wn-newtag">{t('whatsnew.newTag')}</span>}
                  </h3>
                  <p>{lineOf(h)}</p>
                  <button type="button" className="ck-btn ck-btn--sm ck-btn--secondary wn-gtry" onClick={() => tryIt(h)}>
                    {tryOf(h)}
                  </button>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
