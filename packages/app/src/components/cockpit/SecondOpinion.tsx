import { useEffect, useMemo, useState } from 'react';
import {
  plainError,
  reviewedText,
  secondOpinionApi,
  type ParsedReview,
  type ReviewStart,
  type ReviewerEntry,
  type SecondOpinionApi,
  type VerdictLevel,
} from '../../lib/second-opinion';
import { AnnotatedDiff } from './AnnotatedDiff';
import { DotSpinner } from './DotSpinner';
import { plural, splitPatch } from './diff';
import { anchorFindings, reconcileVerdictText, severityGlyph, severityLabel, type ReviewFinding } from './review-diff';
import { beginReview, cancelReview, clearReview, sendToAuthor, useReviewRun } from './second-opinion-store';
import { Sheet } from './Sheet';
import { t, useT } from '../../i18n';
import '../../styles/cockpit-changes.css';
import '../../styles/cockpit-second-opinion.css';

const VERDICT: Record<VerdictLevel, { glyph: string; title: string }> = {
  approve: { glyph: '✓', title: 'Looks good' },
  concerns: { glyph: '!', title: 'Some concerns' },
  changes: { glyph: '!!', title: 'Changes needed' },
  unknown: { glyph: '–', title: 'Review' },
};

/** The reviewer list as the sheet shows it: the author's own agent only when asked for. */
export function visibleReviewers(all: ReviewerEntry[], includeSame: boolean): ReviewerEntry[] {
  return all.filter((r) => includeSame || !r.same);
}

/** The reviewer picked first: a warm one if there is one. */
export function defaultReviewer(list: ReviewerEntry[]): string {
  return (list.find((r) => r.ready) ?? list[0])?.id ?? '';
}

function ReviewerSheet({
  paneId,
  api,
  onClose,
}: {
  paneId: string;
  api: SecondOpinionApi;
  onClose: () => void;
}) {
  const [all, setAll] = useState<ReviewerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeSame, setIncludeSame] = useState(false);
  const [picked, setPicked] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .agents(paneId)
      .then((list) => !cancelled && setAll(list))
      .catch((err) => !cancelled && setError(plainError(err)));
    return () => {
      cancelled = true;
    };
  }, [api, paneId]);

  const list = useMemo(() => visibleReviewers(all ?? [], includeSame), [all, includeSame]);
  const same = (all ?? []).find((r) => r.same);
  const current = list.some((r) => r.id === picked) ? picked : defaultReviewer(list);

  useT();
  return (
    <Sheet role="dialog" labelledBy="ck-so-t" onClose={onClose}>
        <h2 className="ck-section" id="ck-so-t">
          {t('r11.so.who')}
        </h2>
        <p className="ck-sub">{t('r11.so.readOnly')}</p>
        {error && (
          <p className="ck-changes-error" role="alert">
            {error}
          </p>
        )}
        {!all && !error && <p className="ck-sub">{t('r11.so.looking')}</p>}
        {all && list.length === 0 && (
          <p className="ck-sub">
            {same
              ? t('r11.so.onlySame', { label: same.label })
              : t('r11.so.noneReady')}
          </p>
        )}
        {list.length > 0 && (
          <div className="ck-so-list" role="radiogroup" aria-label={t('r11.so.reviewer')}>
            {list.map((r) => (
              <label key={r.id} className={`ck-so-row${current === r.id ? ' is-picked' : ''}`}>
                <input
                  type="radio"
                  name="ck-so-reviewer"
                  value={r.id}
                  checked={current === r.id}
                  onChange={() => setPicked(r.id)}
                />
                <span className="ck-so-name">{r.label}</span>
                {r.same && <span className="ck-so-tag">{t('r11.so.wrote')}</span>}
                {r.ready && <span className="ck-so-tag">{t('r11.so.ready')}</span>}
              </label>
            ))}
          </div>
        )}
        {same && (
          <label className="ck-so-same">
            <input type="checkbox" checked={includeSame} onChange={(e) => setIncludeSame(e.target.checked)} />
            <span>{t('r11.so.allowSame', { label: same.label })}</span>
          </label>
        )}
        <div className="ck-sheet-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={onClose}>
            {t('r11.so.cancel')}
          </button>
          <button
            type="button"
            className="ck-btn ck-btn--primary"
            disabled={!current}
            onClick={() => {
              void beginReview(paneId, current, api);
              onClose();
            }}
          >
            {t('r11.so.start')}
          </button>
        </div>
    </Sheet>
  );
}

function FindingRow({ finding, authorLabel, onSend }: { finding: ReviewFinding; authorLabel: string; onSend: (f: ReviewFinding) => Promise<void> }) {
  useT();
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const place = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return (
    <li className="ck-so-find">
      <span className={`ck-find-sev ck-find-sev--${finding.severity}`} role="img" aria-label={severityLabel(finding.severity)}>
        {severityGlyph(finding.severity)}
      </span>
      <span className="ck-so-find-body">
        <code className="ck-so-place">{place}</code> {finding.text}
      </span>
      <button
        type="button"
        className="ck-btn ck-btn--plain ck-btn--sm"
        disabled={state !== 'idle'}
        onClick={() => {
          setState('sending');
          setError(null);
          onSend(finding).then(
            () => setState('sent'),
            (err) => {
              setState('idle');
              setError(plainError(err));
            },
          );
        }}
      >
        {state === 'sent' ? t('r11.so.sent') : state === 'sending' ? t('r11.so.sending') : t('r11.so.sendTo', { name: authorLabel })}
      </button>
      {error && (
        <span className="ck-find-error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

function Verdict({ review }: { review: ParsedReview }) {
  if (review.verdict) {
    const v = VERDICT[review.verdict.level];
    return (
      <p className="ck-so-verdict" data-level={review.verdict.level}>
        <span className="ck-so-verdict-glyph" aria-hidden>
          {v.glyph}
        </span>
        <strong>{v.title}.</strong> {reconcileVerdictText(review.verdict.text, review.findings.length)}
      </p>
    );
  }
  return null;
}

function Result({
  paneId,
  start,
  review,
  working,
  api,
  onAgain,
}: {
  paneId: string;
  start: ReviewStart;
  review: ParsedReview;
  working: boolean;
  api: SecondOpinionApi;
  onAgain: () => void;
}) {
  useT();
  const bodies = useMemo(() => splitPatch(start.patch), [start.patch]);
  const { byFile, unanchored } = useMemo(() => anchorFindings(review.findings, bodies), [review.findings, bodies]);
  const [open, setOpen] = useState<string | null>(() => [...byFile.keys()][0] ?? null);
  const send = (file: string, line: number | null, text: string) => sendToAuthor(paneId, file, line, text, api).then(() => undefined);
  const inChanges = start.source === 'worktree';
  const pinned = review.findings.length - unanchored.length;

  return (
    <div className="ck-so-result">
      <Verdict review={review} />
      <p className="ck-sub">
        {start.reviewerLabel} reviewed {reviewedText(start)} · {plural(start.files, 'file')} · +{start.additions} −{start.deletions}
        {start.patchTruncated ? t('r11.so.cut') : ''}
      </p>
      {working && <p className="ck-sub">{t('r11.so.stale')}</p>}
      {review.unstructured && (
        <>
          <p className="ck-sub">{t('r11.so.badFormat', { name: start.reviewerLabel })}</p>
          <p className="ck-so-raw">{review.unstructured}</p>
        </>
      )}
      {!review.unstructured && review.findings.length === 0 && <p className="ck-sub">{t('r11.so.noNotes')}</p>}
      {pinned > 0 && inChanges && (
        <p className="ck-sub">{plural(pinned, 'note')} pinned to lines in Changes above.</p>
      )}
      {pinned > 0 && !inChanges && (
        <ul className="ck-changes-files">
          {[...byFile.entries()].map(([file, findings]) => {
            const isOpen = open === file;
            return (
              <li key={file}>
                <button
                  type="button"
                  className={`ck-changes-file${isOpen ? ' is-open' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : file)}
                >
                  <span className="ck-changes-path">{file}</span>
                  <span className="ck-changes-counts">{plural(findings.length, 'note')}</span>
                </button>
                {isOpen && (
                  <AnnotatedDiff file={file} lines={bodies.get(file) ?? []} findings={findings} agentLabel={start.authorLabel} onSend={send} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {unanchored.length > 0 && (
        <>
          <div className="ck-caption">{pinned > 0 ? t('r11.so.elsewhere') : t('r11.so.notes')}</div>
          <ul className="ck-so-finds">
            {unanchored.map((f) => (
              <FindingRow key={f.id} finding={f} authorLabel={start.authorLabel} onSend={(x) => send(x.file, x.line, x.text)} />
            ))}
          </ul>
        </>
      )}
      <div className="ck-changes-actions">
        <button type="button" className="ck-btn ck-btn--secondary" onClick={onAgain}>
          {t('r11.so.again')}
        </button>
        <button type="button" className="ck-btn ck-btn--plain" onClick={() => clearReview(paneId)}>
          {t('r11.so.dismiss')}
        </button>
      </div>
    </div>
  );
}

/**
 * "Second opinion" in the Receipt tab: ask another agent to review what this one just did, read-only.
 * Notes land pinned to diff lines (in Changes for an isolated worktree, else right here) with a
 * verdict, and each one can go back to the agent that wrote the code.
 */
export function SecondOpinion({
  paneId,
  status,
  api = secondOpinionApi,
}: {
  paneId: string;
  status: string;
  api?: SecondOpinionApi;
}) {
  useT();
  const run = useReviewRun(paneId);
  const [sheet, setSheet] = useState(false);
  const working = status === 'running';
  const busy = run?.phase === 'starting' || run?.phase === 'running';

  return (
    <section className="ck-so" aria-label={t('r11.so.title')}>
      <div className="ck-changes-head">
        <h2 className="ck-section">{t('r11.so.title')}</h2>
      </div>
      {!run && (
        <>
          <p className="ck-sub">{t('r11.so.lead')}</p>
          <div className="ck-changes-actions">
            <button
              type="button"
              className="ck-btn ck-btn--secondary"
              disabled={working}
              title={working ? t('r11.so.stillWorking') : undefined}
              onClick={() => setSheet(true)}
            >
              {t('r11.so.title')}
            </button>
          </div>
        </>
      )}
      {busy && (
        <div className="ck-so-busy" role="status">
          <DotSpinner status="running" />
          <span>
            {run?.start ? t('r11.so.reviewing', { name: run.start.reviewerLabel, what: reviewedText(run.start) }) : t('r11.so.starting')}
          </span>
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={() => void cancelReview(paneId, api)}>
            {t('r11.so.stop')}
          </button>
        </div>
      )}
      {run?.phase === 'failed' && (
        <>
          <p className="ck-changes-error" role="alert">
            {run.error}
          </p>
          <div className="ck-changes-actions">
            <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setSheet(true)}>
              {t('r11.so.another')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => clearReview(paneId)}>
              {t('r11.so.dismiss')}
            </button>
          </div>
        </>
      )}
      {run?.phase === 'done' && run.start && run.review && (
        <Result paneId={paneId} start={run.start} review={run.review} working={working} api={api} onAgain={() => setSheet(true)} />
      )}
      {sheet && <ReviewerSheet paneId={paneId} api={api} onClose={() => setSheet(false)} />}
    </section>
  );
}
