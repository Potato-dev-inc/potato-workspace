// The Point box: the small window that opens beside a picked element. It shows state and reports what the person
// does. PointBoxApp owns the state and the calls (see lib/point-api.ts). Every page-derived string is plain text.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PickView, PointState } from '../../lib/point-api';
import { useT } from '../../i18n';
import { RecheckStrip } from './RecheckStrip';
import { MAX_REQUEST, boxKey, groupTargets, sourceLine, targetLabel } from './point-model';

/** Most elements one message carries (the Rust session keeps the same cap). */
export const MAX_PICKS = 3;

export interface PointBoxProps {
  state: PointState;
  request: string;
  onRequest: (text: string) => void;
  /** The chosen pane id, or null when none is chosen yet. */
  target: string | null;
  onTarget: (paneId: string) => void;
  onSend: () => void;
  onEditInChat: () => void;
  onCopy: () => void;
  onPointAnother: () => void;
  onRemove: (pickId: string) => void;
  onDiscard: () => void;
  onHide: () => void;
  onOpenBlocked: () => void;
  /** "Check again" in the before and after strip. */
  onRecheckAgain?: () => void;
  /** Closes the before and after strip. */
  onRecheckClose?: () => void;
  /** One plain sentence about the last action that did not happen. The text stays in the box. */
  error?: string | null;
  /** One plain line about the last action that did happen, e.g. "Copied.". */
  info?: string | null;
  /** A send is in flight. */
  busy?: boolean;
}

function PickRow({ pick, onRemove }: { pick: PickView; onRemove: (id: string) => void }): JSX.Element {
  const t = useT();
  const line = sourceLine(pick);
  return (
    <li className="point-box-pick">
      {pick.thumb ? (
        <img className="point-box-thumb" src={pick.thumb} alt={t('point.shotOf', { label: pick.label })} />
      ) : (
        <div className="point-box-thumb point-box-thumb--none" title={pick.noShotReason || t('point.noShot')}>
          {t('point.noShot')}
        </div>
      )}
      <div className="point-box-pick-body">
        <div className="point-box-pick-head">
          <code className="point-box-tag">{pick.label}</code>
          {pick.text && <span className="point-box-text">{`"${pick.text}"`}</span>}
        </div>
        {line && (
          <div className="point-box-chip" title={line}>
            {line}
          </div>
        )}
        <div className="point-box-page" title={pick.page}>
          {pick.page}
        </div>
      </div>
      <button type="button" className="point-box-x" aria-label={t('point.remove', { label: pick.label })} onClick={() => onRemove(pick.id)}>
        ×
      </button>
    </li>
  );
}

export function PointBox(props: PointBoxProps): JSX.Element {
  const {
    state,
    request,
    onRequest,
    target,
    onTarget,
    onSend,
    onEditInChat,
    onCopy,
    onPointAnother,
    onRemove,
    onDiscard,
    onHide,
    onOpenBlocked,
    onRecheckAgain,
    onRecheckClose,
    error,
    info,
    busy = false,
  } = props;
  const t = useT();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const picks = state.picks;
  const chosen = state.targets.find((x) => x.paneId === target);
  const ready = picks.length > 0;
  const canSend = ready && !!chosen?.canSend && !busy;
  const canCopy = ready && !!chosen && !busy;

  // Focus the text when the box opens and again when another element is added.
  useEffect(() => {
    areaRef.current?.focus();
  }, [picks.length]);

  // Grow with the text. The CSS max-height stops it at six lines.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [request]);

  const onAreaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (boxKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }) === 'send') {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  // Escape hides the box from anywhere inside it.
  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (boxKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }) === 'hide') onHide();
  };

  return (
    <div className="point-box" role="dialog" aria-label={t('point.title')} onKeyDown={onRootKeyDown}>
      {state.recheck && picks.length === 0 ? (
        <RecheckStrip view={state.recheck} onAgain={() => onRecheckAgain?.()} onClose={() => onRecheckClose?.()} />
      ) : (
        <>
      <div className="point-box-head">
        <span className="point-box-title">{t('point.title')}</span>
        <span className="point-box-count">{t('point.count', { n: picks.length, max: MAX_PICKS })}</span>
        <span className="point-box-spacer" />
        <button type="button" className="point-box-btn point-box-btn--plain" onClick={onDiscard}>
          {t('point.discard')}
        </button>
      </div>

      {state.notice && (
        <div className="point-box-notice" role="status">
          <span>{state.notice}</span>
          <button type="button" className="point-box-btn point-box-btn--plain" onClick={onOpenBlocked}>
            {t('point.openInBrowser')}
          </button>
        </div>
      )}

      {ready ? (
        <ul className="point-box-picks">
          {picks.map((p) => (
            <PickRow key={p.id} pick={p} onRemove={onRemove} />
          ))}
        </ul>
      ) : (
        <p className="point-box-empty">{t('point.empty')}</p>
      )}

      <label className="point-box-to">
        <span>{t('point.to')}</span>
        <select className="point-box-select" value={target ?? ''} onChange={(e) => onTarget(e.target.value)} disabled={state.targets.length === 0}>
          {!chosen && <option value="">{t('point.choose')}</option>}
          {groupTargets(state.targets).map((g) => (
            <optgroup key={g.key} label={t(g.key === 'same' ? 'point.group.same' : 'point.group.other')}>
              {g.items.map((item) => (
                <option key={item.paneId} value={item.paneId} disabled={!item.canSend}>
                  {targetLabel(item)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {state.targets.length === 0 && <div className="point-box-reason">{t('point.noTargets')}</div>}
      {chosen && !chosen.canSend && chosen.reason && <div className="point-box-reason">{chosen.reason}</div>}
      {chosen?.canSend && chosen.chat && <div className="point-box-reason">{t('point.chatNote')}</div>}

      <label className="point-box-q" htmlFor="point-box-request">
        {t('point.question')}
      </label>
      <textarea
        id="point-box-request"
        ref={areaRef}
        className="point-box-textarea"
        rows={2}
        maxLength={MAX_REQUEST}
        value={request}
        onChange={(e) => onRequest(e.target.value)}
        onKeyDown={onAreaKeyDown}
      />
      <div className="point-box-hint">{t('point.hint')}</div>

      {(error || info) && (
        <div className={error ? 'point-box-error' : 'point-box-info'} role={error ? 'alert' : 'status'}>
          {error || info}
        </div>
      )}

      <div className="point-box-foot">
        <button type="button" className="point-box-btn point-box-btn--plain" onClick={onPointAnother} disabled={picks.length >= MAX_PICKS || busy}>
          {t('point.another')}
        </button>
        <span className="point-box-spacer" />
        <button type="button" className="point-box-btn" onClick={onCopy} disabled={!canCopy}>
          {t('point.copy')}
        </button>
        <button type="button" className="point-box-btn" onClick={onEditInChat} disabled={!canSend}>
          {t('point.editInChat')}
        </button>
        <button type="button" className="point-box-btn point-box-btn--primary" onClick={onSend} disabled={!canSend}>
          {busy ? t('point.sending') : t('point.send')}
        </button>
      </div>
        </>
      )}
    </div>
  );
}
