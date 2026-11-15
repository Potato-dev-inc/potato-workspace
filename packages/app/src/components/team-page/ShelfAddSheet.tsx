import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { ShelfApi, ShelfApplied, ShelfPreview, ShelfTarget } from '../../lib/shelf';
import { AgentLogo } from '../common/AgentLogo';
import { DisabledReason } from '../common/DisabledReason';
import { defaultAgents, listWords, statusWords, targetsFor, type AddSubject } from './shelf-model';

/** How long Undo stays on screen after an add. */
export const UNDO_SHOW_MS = 10_000;

/**
 * Look, then one click. The sheet shows exactly what Add would write (every file, its path, the text) for the agents
 * ticked, asks for "I trust this" when a tool would run a program, and adds nothing until the person clicks. All text
 * here came from a teammate: it is shown as plain text, never as HTML or Markdown, never inside a link.
 */
export function ShelfAddSheet({ subject, targets, api, onClose, onChanged }: { subject: AddSubject; targets: ShelfTarget[]; api: ShelfApi; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const choices = useMemo(() => targetsFor(subject.kind, targets), [subject.kind, targets]);
  const [agents, setAgents] = useState<string[]>(() => defaultAgents(choices));
  const [preview, setPreview] = useState<ShelfPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ShelfApplied | null>(null);
  const [undone, setUndone] = useState(false);
  const seq = useRef(0);
  const alive = useRef(true);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Every change of the agents asks the backend what would be written. The newest answer wins.
  const key = agents.join('\u0000');
  useEffect(() => {
    if (agents.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const mine = ++seq.current;
    api
      .preview(subject.cardId, agents)
      .then((p) => {
        if (!alive.current || mine !== seq.current) return;
        setPreview(p);
        setPreviewError(null);
      })
      .catch((err) => {
        if (!alive.current || mine !== seq.current) return;
        setPreview(null);
        setPreviewError(errorSentence(err) || t('teamHub.shelf.previewFailed'));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the agents list
  }, [api, subject.cardId, key]);

  // After an add, Undo shows for a short while and the sheet then closes by itself.
  useEffect(() => {
    if (!applied || undone) return;
    const id = window.setTimeout(() => closeRef.current(), UNDO_SHOW_MS);
    return () => window.clearTimeout(id);
  }, [applied, undone]);

  const toggle = (id: string) => setAgents((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const needsTrust = !!preview?.risk?.needsTrust;
  const canAdd = !!preview && preview.canAdd && agents.length > 0 && !busy && (!needsTrust || trusted);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.add(subject.cardId, agents, needsTrust && trusted);
      if (!alive.current) return;
      setApplied(done);
      onChanged();
    } catch (err) {
      if (alive.current) setError(errorSentence(err) || t('teamHub.shelf.addFailed'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const undo = async () => {
    if (!applied?.undo) return;
    setBusy(true);
    setError(null);
    try {
      await api.undo(applied.undo, subject.id);
      if (!alive.current) return;
      setUndone(true);
      onChanged();
    } catch (err) {
      if (alive.current) setError(errorSentence(err) || t('teamHub.shelf.undoFailed'));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const title = t('teamHub.shelf.add.title', { name: subject.name });
  if (applied) {
    return (
      <div className="tpg-sheet tpg-shelf-sheet" role="dialog" aria-label={title} data-testid="shelf-add-sheet">
        <h3 className="tpg-sheet-title">{title}</h3>
        <p role="status" data-testid="shelf-added-line">
          {undone ? t('teamHub.shelf.undone') : t('teamHub.shelf.addedTo', { agents: listWords(applied.addedTo) })}
        </p>
        {error && (
          <p className="tpg-error" role="alert">
            {error}
          </p>
        )}
        <div className="tpg-actions">
          {applied.undo && !undone && (
            <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={() => void undo()}>
              {t('teamHub.shelf.undo')}
            </button>
          )}
          <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
            {t('teamHub.shelf.close')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tpg-sheet tpg-shelf-sheet" role="dialog" aria-label={title} data-testid="shelf-add-sheet">
      <h3 className="tpg-sheet-title">{title}</h3>
      <p className="tpg-sub">{t('teamHub.shelf.suggestedBy', { name: subject.byName })}</p>

      <fieldset className="tpg-radios">
        <legend className="tpg-h">{t('teamHub.shelf.add.agents')}</legend>
        {choices.map((c) => (
          <label key={c.id} className="tpg-radio">
            <input type="checkbox" checked={agents.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className="tpg-shelf-agent">
              <AgentLogo id={c.id} name={c.label} size={16} decorative />
              {c.label}
              {!c.installed && <small>{t('teamHub.shelf.notInstalled')}</small>}
            </span>
          </label>
        ))}
        {choices.length === 0 && <p className="tpg-sub">{t('teamHub.shelf.noAgents')}</p>}
      </fieldset>

      {agents.length === 0 && choices.length > 0 && <p className="tpg-sub">{t('teamHub.shelf.pickAgent')}</p>}
      {previewError && (
        <p className="tpg-error" role="alert">
          {previewError}
        </p>
      )}

      {preview && (
        <div data-testid="shelf-preview">
          {preview.risk && (
            <div className="tpg-shelf-risk">
              <p className="tpg-h">{t('teamHub.shelf.runs')}</p>
              <pre className="tpg-shelf-code" data-testid="shelf-risk-shown">
                {preview.risk.shown}
              </pre>
              <p className="tpg-note">{t('teamHub.shelf.runs.warn', { name: subject.byName })}</p>
              {preview.risk.reasons.length > 0 && (
                <ul className="tpg-shelf-reasons">
                  {preview.risk.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              {preview.risk.needsTrust && (
                <label className="tpg-radio">
                  <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
                  <span>{t('teamHub.shelf.trust')}</span>
                </label>
              )}
            </div>
          )}
          {preview.needs.length > 0 && <p className="tpg-note">{t('teamHub.shelf.needsAfter', { names: preview.needs.join(', ') })}</p>}
          {preview.skippedFiles > 0 && <p className="tpg-note">{t('teamHub.shelf.skipped', { count: preview.skippedFiles })}</p>}
          <p className="tpg-h">{t('teamHub.shelf.willWrite')}</p>
          <ul className="tpg-shelf-writes">
            {preview.writes.map((w, i) => (
              <li key={i} className="tpg-shelf-write" data-testid="shelf-write" data-status={w.status}>
                <div className="tpg-person-head">
                  <span className="tpg-name">{listWords(w.agents.map((a) => a.label))}</span>
                  <span className="tpg-chip" data-status={w.status}>
                    {statusWords(w.status)}
                  </span>
                </div>
                <p className="tpg-sub tpg-shelf-path">{w.path}</p>
                {w.reason && <p className="tpg-note">{w.reason}</p>}
                {w.text && <pre className="tpg-shelf-code">{w.text}</pre>}
              </li>
            ))}
          </ul>
          {preview.blocked && (
            <p className="tpg-note" role="status" data-testid="shelf-blocked">
              {preview.blocked}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="tpg-error" role="alert">
          {error}
        </p>
      )}
      <div className="tpg-actions">
        <button type="button" className="ck-btn ck-btn--primary" disabled={!canAdd} onClick={() => void add()}>
          {t('teamHub.shelf.addToAgents')}
        </button>
        <DisabledReason reason={!canAdd && !busy && !!preview?.canAdd && agents.length > 0 && needsTrust && !trusted ? t('teamHub.shelf.tickFirst') : null} />
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('teamHub.shelf.cancel')}
        </button>
      </div>
    </div>
  );
}
