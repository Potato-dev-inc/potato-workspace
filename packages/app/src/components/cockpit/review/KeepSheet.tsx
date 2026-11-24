// The confirm sheet for Keep. Merge (a copy or a Night Shift task) asks `Merge into main?`; an issue run asks
// for a draft pull request. Nothing happens until the primary button or Enter is pressed, and Enter confirms
// once. Refusals use the same plain sentences as the Copies tab (`plainMergeError`).
import { useRef, useState, type KeyboardEvent } from 'react';
import { plainMergeError } from '../Changes';
import { Sheet } from '../Sheet';
import { t, useT } from '../../../i18n';
import { reasonText } from '../../../lib/review-reasons';
import { reviewDeskApi, reviewDeskError, type ReviewAct, type ReviewItem } from '../../../lib/review-desk';

/** The one call this sheet makes. A test double can stand in for it. */
export type ReviewKeepApi = Pick<typeof reviewDeskApi, 'keep'>;

export interface KeepSheetProps {
  item: ReviewItem;
  /** Issue runs: the push-check reasons (the detail's `extra`). `null` = not loaded yet. */
  extra?: string[] | null;
  api?: ReviewKeepApi;
  /** Keep worked. The parent closes the sheet and refreshes the list. */
  onDone: (act: ReviewAct) => void;
  onCancel: () => void;
}

const TITLE_ID = 'ck-rd-keep-title';

/** The copy of a Keep sheet for one kind. Merge and Night Shift share the same words. */
export function keepSheetCopy(item: ReviewItem) {
  if (item.keep.kind === 'issue_push') {
    return {
      title: t('r11.rd.pushTitle'),
      primary: t('r11.rd.pushPrimary'),
      footer: t('r11.rd.pushFoot'),
    };
  }
  const into = item.keep.into || t('r11.rd.yourProject');
  const n = item.files.total;
  return {
    title: t('r11.rd.mergeTitle', { into }),
    primary: t('r11.rd.mergePrimary'),
    body: t('r11.rd.mergeBody', { count: n, into }),
  };
}

export function KeepSheet({ item, extra = [], api = reviewDeskApi, onDone, onCancel }: KeepSheetProps) {
  useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; title?: string } | null>(null);
  // A ref, not state: a second Enter in the same tick must not call Keep twice.
  const busyRef = useRef(false);
  const copy = keepSheetCopy(item);
  const issue = item.keep.kind === 'issue_push';
  // Look first: the riskiest reason, only when the item is at tier 4 or higher (riskier than a test change).
  const warn = !issue && item.tier <= 4 && item.reasons[0] ? reasonText(item.reasons[0]) : null;

  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const act = await api.keep(item.key, item.fingerprint);
      onDone(act);
    } catch (err) {
      busyRef.current = false;
      setBusy(false);
      const failure = reviewDeskError(err);
      const mapped = plainMergeError(failure.code ? `${failure.code}: ${failure.message}` : failure.message);
      setError({ text: mapped.title ? mapped.text : failure.message, title: mapped.title });
    }
  };

  // Enter confirms. A focused button keeps its own Enter (a click), so the button is skipped here.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    void confirm();
  };

  return (
    <Sheet labelledBy={TITLE_ID} onClose={busy ? undefined : onCancel} className="ck-rd-sheet">
      <div className="ck-rd-sheet-body" onKeyDown={onKeyDown}>
        <h2 className="ck-section" id={TITLE_ID}>
          {copy.title}
        </h2>
        {issue ? (
          extra === null ? (
            <p className="ck-sub">{t('r11.rd.pushChecking')}</p>
          ) : extra.length > 0 ? (
            <ul className="ck-rd-sheet-list">
              {extra.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="ck-sub">{t('r11.rd.pushClean')}</p>
          )
        ) : (
          <p className="ck-sub">{copy.body}</p>
        )}
        {warn && <p className="ck-rd-sheet-warn">{t('r11.rd.lookFirst', { why: warn })}</p>}
        {error && (
          <p className="ck-rd-sheet-error" role="alert" title={error.title}>
            {error.text}
          </p>
        )}
        {issue && <p className="ck-rd-sheet-foot">{copy.footer}</p>}
        <div className="ck-sheet-actions">
          <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={onCancel}>
            {t('r11.rd.cancel')}
          </button>
          <button type="button" className="ck-btn ck-btn--primary" autoFocus disabled={busy} onClick={() => void confirm()}>
            {copy.primary}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
