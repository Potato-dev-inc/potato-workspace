// "Branch from here": the sheet a chat turn's Branch button or a History row opens. It shows the save point, lets the
// person pick Before or After this turn (chat only), pick an agent and say what it should do. Nothing is written
// until Start: then Potato Workspace makes a separate copy from the save point and starts the agent in it
// (src/lib/branch-from.ts). Only the agents the server marks ok can be picked; the others say why not.
import { errorSentence } from '../../lib/sayError';
import { t, useT, type MessageKey } from '../../i18n';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  branchPreview,
  branchStart,
  type BranchFrom,
  type BranchOffer,
  type BranchPointView,
  type BranchPreview,
  type BranchView,
  type BranchWhen,
} from '../../lib/branch-from';
import '../../styles/cockpit-branch.css';
import { briefSize } from './BriefSheet';
import { Sheet } from './Sheet';

/** The most characters the task box takes. The server refuses more. */
export const MESSAGE_MAX_CHARS = 4_000;
/** The counter shows once the box holds more than this many characters. */
export const COUNTER_FROM_CHARS = 3_500;
/** The brief preview asks again this long after the last key press. */
const BRIEF_DEBOUNCE_MS = 400;

/** The server's fixed sentences (branch_from/model.rs) in the app's language; any other text stays as it came. */
const SERVER_TEXT: Record<string, MessageKey> = {
  "Branching isn't available for this pane.": 'r10.branch.notHere',
  'There is no save point for this turn. Save points are made while Undo is on.': 'r10.branch.noSavePoint',
  "This message has no time, so its save point can't be found. Pick one in History.": 'r10.branch.noTimes',
  'This turn is still running. Branch after it ends, or pick "Before this turn".': 'r10.branch.stillRunning',
  'Branching needs Git in this folder. Use "Set up Git here" first.': 'r10.branch.needsGit',
  'Branching needs one commit in this folder first.': 'r10.branch.noCommits',
  'This chat has 5 open branches. Keep or throw away one in Changes first.': 'r10.branch.tooMany',
  'A branch is already being made from this chat. Wait a moment.': 'r10.branch.busy',
  "That agent can't be picked.": 'r10.branch.badTarget',
  'Tell the agent what to do.': 'r10.branch.emptyMessage',
  'Make your message shorter (4,000 characters at most).': 'r10.branch.tooLong',
};
const said = (text: string): string => (SERVER_TEXT[text] ? t(SERVER_TEXT[text]) : text);

/** Backend errors read `CODE: message`. The person sees only the message, in plain words. */
function friendlyError(err: unknown): string {
  const raw = errorSentence(err);
  const text = raw.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, '').trim();
  if (!text || /^[A-Z][A-Z0-9_]+$/.test(text)) return t('r10.branch.generic');
  return said(text);
}

/** The clock time of a moment, as "14:02". */
function clockText(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** "Save point: After turn 5 · 14:02 · 3 files changed in that turn". The file part is left out when it is 0. */
function savePointLine(point: BranchPointView): string {
  const files = point.files > 0 ? ` · ${t('r10.branch.filesChanged', { count: point.files })}` : '';
  return `${t('r10.branch.savePoint')}: ${point.label} · ${clockText(point.atMs)}${files}`;
}

/** `agent` or `agent@account`: the text the server takes as the target. */
function offerKey(offer: BranchOffer): string {
  return offer.target.account ? `${offer.target.agent_id}@${offer.target.account}` : offer.target.agent_id;
}

function firstOk(offers: BranchOffer[]): string | null {
  const first = offers.find((o) => o.ok);
  return first ? offerKey(first) : null;
}

/** The "From" of a chat turn, with the switch's side. A History row has no side. */
function withWhen(from: BranchFrom, when: BranchWhen): BranchFrom {
  return from.kind === 'message' ? { kind: 'message', user_item_id: from.user_item_id, when } : from;
}

export function BranchSheet({
  paneId,
  from,
  onClose,
  onStarted,
}: {
  /** The pane whose chat or History the branch starts from. */
  paneId: string;
  /** A chat turn (`message`) or a History row (`save_point`). */
  from: BranchFrom;
  onClose: () => void;
  /** Called with the new branch once Start has made it (its pane is starting). */
  onStarted?: (view: BranchView) => void;
}) {
  const t = useT();
  const uid = useId();
  const titleId = `${uid}-title`;
  const fieldId = `${uid}-field`;
  const [when, setWhen] = useState<BranchWhen>(from.kind === 'message' ? from.when : 'after');
  const effective = withWhen(from, when);
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  const [preview, setPreview] = useState<BranchPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [briefOpen, setBriefOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The message the last "Before this turn" filled in. A text the person typed is never overwritten.
  const prefilled = useRef<string | null>(null);
  // Only the newest preview counts: an older answer that arrives late is dropped.
  const seq = useRef(0);

  const load = useCallback(
    (next: BranchFrom, text: string | null, fillPrefill: boolean) => {
      const mine = ++seq.current;
      return branchPreview(paneId, next, null, text)
        .then((p) => {
          if (mine !== seq.current) return;
          setPreview(p);
          setLoadError(null);
          setPicked((prev) => (prev !== null && p.offers.some((o) => o.ok && offerKey(o) === prev) ? prev : firstOk(p.offers)));
          if (fillPrefill && p.prefill !== null) {
            const fill = p.prefill;
            const previous = prefilled.current;
            setMessage((cur) => (cur.trim() === '' || cur === previous ? fill : cur));
            prefilled.current = fill;
          }
        })
        .catch((err: unknown) => {
          if (mine === seq.current) setLoadError(friendlyError(err));
        });
    },
    [paneId],
  );

  useEffect(() => {
    void load(effectiveRef.current, null, false);
  }, [load]);

  // The brief preview follows the text while its disclosure is open, after a short pause. An empty box asks nothing.
  useEffect(() => {
    if (!briefOpen || message.trim() === '') return;
    const timer = setTimeout(() => void load(effectiveRef.current, message, false), BRIEF_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [briefOpen, message, when, load]);

  const choose = (next: BranchWhen) => {
    if (busy || next === when) return;
    setWhen(next);
    void load(withWhen(from, next), briefOpen ? message : null, next === 'before');
  };

  const blocked = preview !== null ? !preview.canBranch : loadError !== null;
  const chosen = preview?.offers.find((o) => o.ok && offerKey(o) === picked) ?? null;
  const tooLong = message.length > MESSAGE_MAX_CHARS;
  const canStart = !blocked && chosen !== null && message.trim() !== '' && !tooLong && !busy;

  const go = async () => {
    if (!chosen || !canStart) return;
    setBusy(true);
    setError(null);
    try {
      const view = await branchStart(paneId, effective, offerKey(chosen), message.trim());
      onStarted?.(view);
      onClose();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  if (blocked) {
    const reason = said(preview?.whyNot ?? '') || (preview === null ? loadError : null) || t('r10.branch.notHere');
    return (
      <Sheet onClose={onClose} role="dialog" labelledBy={titleId} className="ck-branch-sheet">
        <div id={titleId} className="ck-title">
          {t('r10.branch.title')}
        </div>
        <p className="ck-sub">{reason}</p>
        <div className="ck-sheet-actions">
          <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" onClick={onClose}>
            {t('r10.close')}
          </button>
        </div>
      </Sheet>
    );
  }

  // The brief shows only while the box holds text.
  const shown = message.trim() === '' ? null : (preview?.brief ?? null);
  const overText = message.length > COUNTER_FROM_CHARS;

  return (
    <Sheet onClose={busy ? undefined : onClose} role="dialog" labelledBy={titleId} className="ck-branch-sheet">
      <div id={titleId} className="ck-title">
        {t('r10.branch.title')}
      </div>
      {preview?.point && <p className="ck-sub ck-branch-point">{savePointLine(preview.point)}</p>}
      {preview === null && loadError === null && <p className="ck-sub">{t('r10.branch.looking')}</p>}
      {from.kind === 'message' && (
        <div className="ck-branch-seg" role="group" aria-label={t('r10.branch.savePoint')}>
          <button type="button" className="ck-branch-seg-btn" aria-pressed={when === 'after'} disabled={busy} onClick={() => choose('after')}>
            {t('r10.branch.after')}
          </button>
          <button type="button" className="ck-branch-seg-btn" aria-pressed={when === 'before'} disabled={busy} onClick={() => choose('before')}>
            {t('r10.branch.before')}
          </button>
        </div>
      )}
      <div className="ck-branch-label" id={`${uid}-agent`}>
        {t('r10.branch.agent')}
      </div>
      {preview !== null && preview.offers.length === 0 && <p className="ck-sub">{t('r10.branch.noAgent')}</p>}
      {preview !== null && preview.offers.length > 0 && (
        <div className="ck-branch-list" role="radiogroup" aria-labelledby={`${uid}-agent`}>
          {preview.offers.map((o) => {
            const key = offerKey(o);
            return (
              <label key={key} className={`ck-branch-row${o.ok ? '' : ' is-off'}`}>
                <input
                  type="radio"
                  name={`${uid}-agent-pick`}
                  value={key}
                  checked={picked === key}
                  disabled={!o.ok || busy}
                  onChange={() => setPicked(key)}
                />
                <span className="ck-branch-name">{o.label}</span>
                <span className="ck-branch-state">{o.ok ? t('r10.branch.ready') : (o.whyNot ?? t('r10.branch.unavailable'))}</span>
              </label>
            );
          })}
        </div>
      )}
      <div className="ck-branch-field">
        <label htmlFor={fieldId} className="ck-branch-label">
          {t('r10.branch.what')}
        </label>
        <textarea
          id={fieldId}
          className="ck-branch-input"
          rows={4}
          maxLength={MESSAGE_MAX_CHARS}
          placeholder={t('r10.branch.placeholder')}
          value={message}
          disabled={busy}
          onChange={(e) => setMessage(e.target.value)}
        />
        {overText && (
          <span className={`ck-branch-count${tooLong ? ' is-over' : ''}`}>
            {`${message.length.toLocaleString('en-US')} / ${MESSAGE_MAX_CHARS.toLocaleString('en-US')}`}
          </span>
        )}
        {tooLong && <p className="ck-sub">{t('r10.branch.tooLong')}</p>}
      </div>
      <button type="button" className="ck-branch-disclosure" aria-expanded={briefOpen} onClick={() => setBriefOpen((open) => !open)}>
        {t('r10.branch.show')}
      </button>
      {briefOpen && (
        <div className="ck-branch-brief-box">
          {shown ? (
            <>
              <pre className="ck-branch-brief" tabIndex={0} aria-label={t('r10.branch.gets')}>
                {shown.text}
              </pre>
              <div className="ck-sub">{`${briefSize(shown.text)} · ${t('r10.branch.trimmed')}: ${shown.trimmed.length > 0 ? shown.trimmed.join(', ') : t('r10.branch.none')}`}</div>
            </>
          ) : (
            <p className="ck-sub">{message.trim() === '' ? t('r10.branch.typeFirst') : t('r10.branch.loadingBrief')}</p>
          )}
        </div>
      )}
      <p className="ck-sub ck-branch-copy">
        {t('r10.branch.copy')}
      </p>
      {loadError && (
        <p className="ck-memory-msg ck-memory-err" role="alert">
          {loadError}
        </p>
      )}
      {error && (
        <p className="ck-memory-msg ck-memory-err" role="alert">
          {error}
        </p>
      )}
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose} disabled={busy}>
          {t('r10.cancel')}
        </button>
        <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" disabled={!canStart} onClick={() => void go()}>
          {busy ? t('r10.branch.starting') : chosen ? t('r10.branch.startNamed', { name: chosen.label }) : t('r10.branch.start')}
        </button>
      </div>
    </Sheet>
  );
}
