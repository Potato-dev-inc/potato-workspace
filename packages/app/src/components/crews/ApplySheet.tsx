// "Get helpers ready now": pick a folder, then each role with a number gets that many one-time standby helpers there (not refilled).
// No task starts and no pane opens. If the standby limit is lower than the crew needs, the sheet says so and asks first.
// 1.1.8 slot (Standbys look after themselves): suggestions, memory per helper and sleep for idle ones come here later.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT, type MessageKey } from '../../i18n';
import { tauriStandbyHelpersApi, useStandbyHelpers, type StandbyHelpersApi } from '../../lib/standbyHelpers';
import { crewErrorText, type Crew, type CrewApplied, type CrewsApi } from '../../lib/crews-api';
import type { ShipApi } from '../../lib/ship-api';
import { useSheetKeys } from '../cockpit/Sheet';
import { openStartCrew } from '../../lib/startCrewEvent';
import { standbyTotal } from './model';

export function ApplySheet({
  crew,
  api,
  ship,
  defaultFolder,
  onClose,
  standbyApi = tauriStandbyHelpersApi,
  onStartCrew = openStartCrew,
}: {
  crew: Crew;
  api: Pick<CrewsApi, 'apply'>;
  ship: Pick<ShipApi, 'pickFolder'>;
  defaultFolder?: string | null;
  onClose: () => void;
  standbyApi?: StandbyHelpersApi;
  /** Opens the Start crew sheet (the cockpit's own). */
  onStartCrew?: () => void;
}) {
  const t = useT();
  const ref = useSheetKeys(onClose);
  const [folder, setFolder] = useState<string | null>(defaultFolder ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CrewApplied | null>(null);
  const count = standbyTotal(crew);
  // What each new standby is doing now (ready, starting, or why it cannot start): "made" is not the same as "ready".
  const { view: standbys } = useStandbyHelpers(standbyApi);
  const stateOf = (name: string): string | null => {
    const norm = (p: string) => p.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
    const same = (a: string, b: string) => norm(a) === norm(b);
    // The role's name AND the folder: two standbys with the same role name in different folders keep their own state.
    const h = standbys.helpers.find((x) => x.name === name && (!folder || same(x.project, folder)));
    if (!h) return null;
    const note = h.state === 'problem' && h.note ? ` · ${t(`standby.note.${h.note}` as MessageKey)}` : '';
    return `${t(`standby.state.${h.state}` as MessageKey)}${note}`;
  };

  const pick = async () => {
    setError(null);
    try {
      const found = await ship.pickFolder();
      if (found) setFolder(found.path);
    } catch (err) {
      setError(crewErrorText(err));
    }
  };

  const go = async (raise: boolean) => {
    if (!folder) {
      setError(t('crewcanvas.sheet.noFolder'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await api.apply(crew, folder, raise);
      if (out.problems.length > 0) setError(out.problems[0].message);
      else setResult(out);
    } catch (err) {
      setError(crewErrorText(err) || t('crewcanvas.sheet.failed'));
    }
    setBusy(false);
  };

  const needsLimit = result?.needs_limit ?? null;
  // The reason the button is off, said in words (the person could not tell why it was dim).
  const whyOff = count === 0 ? null : !folder ? t('crewcanvas.sheet.pickFirst') : null;
  // Drawn on the page itself, not inside the canvas: the canvas clips what is drawn in it (the sheet was cut off at the right edge).
  return createPortal(
    <div className="crewc-scrim" onMouseDown={onClose}>
      <div ref={ref} className="crewc-modal" role="dialog" aria-modal="true" aria-labelledby="crewc-apply-t" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="crewc-apply-t">{t('crewcanvas.sheet.title')}</h2>
        {count === 0 ? (
          <p className="crewc-warn" data-testid="apply-none">{t('crewcanvas.sheet.none')}</p>
        ) : (
          <p>{t('crewcanvas.sheet.about', { count })}</p>
        )}
        {!result ? <p className="crewc-how">{t('crewcanvas.sheet.how')}</p> : null}
        {count > 0 && (!result || needsLimit) ? (
          <div className="crewc-field">
            <span>{t('crewcanvas.sheet.folder')}</span>
            <div className="crewc-folder">
              <code>{folder ?? '—'}</code>
              <button type="button" className="crewc-btn" onClick={() => void pick()} disabled={busy}>
                {t('crewcanvas.sheet.pick')}
              </button>
            </div>
          </div>
        ) : null}
        {result && !needsLimit ? (
          <ul className="crewc-result" data-testid="apply-result">
            <li>{result.added.length > 0 ? t('crewcanvas.sheet.added', { count: result.added.length }) : t('crewcanvas.sheet.nothing')}</li>
            {result.added.map((name) => (
              <li key={name} className="crewc-made" data-testid="apply-made">{stateOf(name) ? `${name} · ${stateOf(name)}` : name}</li>
            ))}
            {result.already > 0 ? <li>{t('crewcanvas.sheet.already', { count: result.already })}</li> : null}
            {result.skipped.map((s) => (
              <li key={s.role}>{t('crewcanvas.sheet.skipped', { role: s.role, why: s.why })}</li>
            ))}
          </ul>
        ) : null}
        {result && !needsLimit && result.added.length > 0 ? (
          <p className="crewc-how" data-testid="apply-next">{t('crewcanvas.sheet.next')}</p>
        ) : null}
        {needsLimit ? <p className="crewc-warn">{t('crewcanvas.sheet.limit', { count: needsLimit })}</p> : null}
        {whyOff && !result ? <p className="crewc-hint" data-testid="apply-why-off">{whyOff}</p> : null}
        {error ? (
          <p className="crewc-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="crewc-actions">
          {result && !needsLimit ? (
            <>
              {result.added.length > 0 ? (
                <button type="button" className="crewc-btn" onClick={() => { onClose(); onStartCrew(); }}>
                  {t('crewcanvas.sheet.startCrew')}
                </button>
              ) : null}
              <button type="button" className="crewc-btn crewc-btn--primary" onClick={onClose} autoFocus>
                {t('crewcanvas.sheet.done')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="crewc-btn" onClick={onClose} disabled={busy}>
                {t('crewcanvas.sheet.cancel')}
              </button>
              {needsLimit ? (
                <button type="button" className="crewc-btn crewc-btn--primary" onClick={() => void go(true)} disabled={busy}>
                  {t('crewcanvas.sheet.raise')}
                </button>
              ) : (
                <button type="button" className="crewc-btn crewc-btn--primary" onClick={() => void go(false)} disabled={busy || count === 0 || !folder}>
                  {busy ? t('crewcanvas.sheet.working') : t('crewcanvas.sheet.go')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
