// Review Desk on the phone (SPEC n33 3.9): a read-only card under the Night summary on the phone home.
// It shows `4 to review · 1 high risk` from `GET /review-desk`.
// One quiet row ("On your PC · 4 to review · 1 high risk"), no list and no buttons: where to act is already said by the row's label.
// Hidden when nothing is waiting, and it keeps the last count it read when a read fails.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { PhoneReviewView, ReviewPhoneApi } from '../../lib/mobile-review';
import '../../styles/phone-shell.css';

/** The read repeats this often while the card is up (a copy or a turn can finish on the PC at any time). */
const REFRESH_MS = 10_000;

export function ReviewSummary({
  api,
  refreshKey = 0,
}: {
  api: ReviewPhoneApi | null;
  /** Bumped when the stream resynced: the card reads again at once. */
  refreshKey?: number;
}) {
  const t = useT();
  const [view, setView] = useState<PhoneReviewView | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    const load = () => {
      api
        .read()
        .then((next) => {
          if (live) setView(next);
        })
        // The card is optional: a refused or failed read keeps what is shown.
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api, refreshKey]);

  if (!view || view.count === 0) return null;
  const line = view.high > 0 ? t('phone.sh.reviewHigh', { count: view.count, high: view.high }) : t('phone.sh.review', { count: view.count });

  return (
    <div className="ph-qrow" data-review-count={view.count} role="group" aria-label={t('phone.sh.onPc')} data-testid="phone-review-row">
      <span className="ph-qrow-label">{t('phone.sh.onPc')}</span>
      <span className="ph-qrow-text">{line}</span>
    </div>
  );
}
