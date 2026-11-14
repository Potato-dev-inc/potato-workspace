// "Check it again" (N5-21): the before and after strip the Point box shows once a chat agent's turn ended and the
// preview was reloaded. Two small pictures side by side; a click enlarges one. Every string is plain text.
import { useState } from 'react';
import type { RecheckView } from '../../lib/point-api';
import { useT } from '../../i18n';

export interface RecheckStripProps {
  view: RecheckView;
  onAgain: () => void;
  onClose: () => void;
}

type Which = 'before' | 'after';

export function RecheckStrip({ view, onAgain, onClose }: RecheckStripProps): JSX.Element {
  const t = useT();
  const [big, setBig] = useState<Which | null>(null);
  const bigSrc = big ? view[big] : null;

  const cell = (which: Which): JSX.Element => {
    const src = view[which];
    const name = t(which === 'before' ? 'point.recheck.before' : 'point.recheck.after');
    return (
      <figure className="point-recheck-cell" data-testid={`recheck-${which}`}>
        {src ? (
          <button
            type="button"
            className="point-recheck-img-btn"
            aria-label={t('point.recheck.enlarge', { which: name })}
            onClick={() => setBig(which)}
          >
            <img className="point-recheck-img" src={src} alt={name} />
          </button>
        ) : (
          <div className="point-recheck-img point-recheck-img--none">
            {view.busy && which === 'after' ? t('point.recheck.working') : t(which === 'before' ? 'point.recheck.noBefore' : 'point.recheck.noAfter')}
          </div>
        )}
        <figcaption>{name}</figcaption>
      </figure>
    );
  };

  return (
    <section className="point-recheck" aria-label={t('point.recheck.title')} data-testid="recheck-strip">
      <div className="point-box-head">
        <span className="point-box-title">{t('point.recheck.title')}</span>
        <span className="point-box-spacer" />
        <button type="button" className="point-box-btn point-box-btn--plain" onClick={onClose}>
          {t('point.recheck.close')}
        </button>
      </div>
      <div className="point-recheck-line">
        <code className="point-box-tag">{view.label}</code>
        <span className="point-box-page" title={view.agent}>
          {t('point.recheck.done', { agent: view.agent })}
        </span>
      </div>
      <div className="point-recheck-strip">
        {cell('before')}
        {cell('after')}
      </div>
      {view.note && (
        <div className="point-box-reason" role="status">
          {view.note}
        </div>
      )}
      <div className="point-box-foot">
        <span className="point-box-spacer" />
        <button type="button" className="point-box-btn" onClick={onAgain} disabled={view.busy}>
          {t('point.recheck.again')}
        </button>
      </div>
      {big && bigSrc && (
        <div className="point-recheck-big" role="dialog" aria-label={t('point.recheck.enlarge', { which: t(big === 'before' ? 'point.recheck.before' : 'point.recheck.after') })} onClick={() => setBig(null)}>
          <img src={bigSrc} alt="" />
        </div>
      )}
    </section>
  );
}
