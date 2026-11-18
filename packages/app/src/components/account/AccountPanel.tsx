// Connect > My PCs, "Your Potato account" (Labs `account_enabled`): one Sign in button that opens the browser, then
// "My devices" with Sign out this device, and a banner for a device that signed in during the last 24 hours.
// Phase 1 lists only: nothing here lets a device reach another one. Names come from the devices, so they are text only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { accountApi, newDevices, readDismissed, rememberDismissed, type AccountApi, type AccountDevice, type AccountView } from '../../lib/account';
import '../../styles/account.css';

/** How often the list is read again while the page is open. */
const REFRESH_MS = 20_000;

function seen(t: ReturnType<typeof useT>, d: AccountDevice, nowSecs: number): string {
  if (d.revoked) return t('account.signedOut');
  if (d.online) return t('account.online');
  const mins = Math.max(0, Math.floor((nowSecs - d.last_seen_at) / 60));
  if (mins < 1) return t('account.online');
  if (mins < 60) return t('account.seenMinutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t('account.seenHours', { count: hours });
  return t('account.seenDays', { count: Math.floor(hours / 24) });
}

export function AccountPanel({ api = accountApi, now = () => Math.floor(Date.now() / 1000), compact = false }: { api?: AccountApi; now?: () => number; /** Signed in: one grey line (who, and Sign out this device) instead of the device list. A new device still gets its banner. */ compact?: boolean }) {
  const t = useT();
  const [view, setView] = useState<AccountView | null>(null);
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const alive = useRef(true);

  const loadDevices = useCallback(() => {
    api
      .devices()
      .then((r) => {
        if (!alive.current) return;
        setDevices(r.devices);
        if (!r.signed_in) void api.state().then((v) => alive.current && setView(v));
      })
      .catch(() => alive.current && setError(t('account.listFailed')));
  }, [api, t]);

  const refresh = useCallback(() => {
    api
      .state()
      .then((v) => {
        if (!alive.current) return;
        setView(v);
        if (v.signed_in) loadDevices();
        else setDevices([]);
      })
      .catch(() => alive.current && setView(null));
  }, [api, loadDevices]);

  useEffect(() => {
    alive.current = true;
    refresh();
    let stop: (() => void) | null = null;
    void api.onChanged(refresh).then((un) => {
      if (alive.current) stop = un;
      else un();
    });
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      alive.current = false;
      stop?.();
      window.clearInterval(timer);
    };
  }, [api, refresh]);

  const run = (key: string, job: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError(null);
    job()
      .then(() => after?.())
      .catch((e: unknown) => alive.current && setError(typeof e === 'string' && e ? e : t('account.failed')))
      .finally(() => {
        if (!alive.current) return;
        setBusy(null);
        refresh();
      });
  };

  if (!view) return null;
  const nowSecs = now();
  const fresh = newDevices(devices, nowSecs, dismissed);
  const dismiss = (id: string) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    rememberDismissed(next);
  };

  const thisDevice = devices.find((d) => d.is_this && !d.revoked);
  if (compact && view.signed_in) {
    return (
      <div className="ac-compact" data-testid="account-panel">
        {fresh.map((d) => (
          <div key={d.id} className="ac-banner" role="status" data-testid="account-new-device">
            <span>
              {t('account.newDevice')} · <b>{d.name}</b>
            </span>
            <span className="ac-actions">
              <button type="button" className="ck-btn" data-testid="account-not-me" disabled={busy === `notme:${d.id}`} onClick={() => run(`notme:${d.id}`, () => api.revoke(d.id, 'not_me'), () => setWarned(true))}>
                {t('account.notMe')}
              </button>
              <button type="button" className="ck-btn" data-testid="account-its-me" onClick={() => dismiss(d.id)}>
                {t('account.itsMe')}
              </button>
            </span>
          </div>
        ))}
        {warned && (
          <p className="ac-note" role="status" data-testid="account-not-me-advice">
            {t('account.notMeAdvice')}
          </p>
        )}
        <p className="ac-note" data-testid="account-as">
          {t('account.signedInAs', { name: view.account?.display_name ?? '' })}
          {thisDevice && (
            <>
              {' '}
              <button type="button" className="cx-link" data-testid={`account-sign-out-${thisDevice.id}`} disabled={busy === `out:${thisDevice.id}`} onClick={() => run(`out:${thisDevice.id}`, api.signOutHere)}>
                {t('account.signOutThis')}
              </button>
            </>
          )}
        </p>
        {(error ?? view.message) && (
          <p className="ac-error" role="alert" data-testid="account-error">
            {error ?? view.message}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="ac-panel" data-testid="account-panel" aria-label={t('account.title')}>
      <h2 className="ac-title">{t('account.title')}</h2>
      {!view.signed_in ? (
        <>
          <p className="ac-line">{t('account.blurb')}</p>
          {!view.configured && (
            <p className="ac-note" data-testid="account-not-ready">
              {t('account.notReady')}
            </p>
          )}
          {view.waiting ? (
            <div className="ac-row">
              <p className="ac-line" data-testid="account-waiting">
                {t('account.waiting')}
              </p>
              <button type="button" className="ck-btn" data-testid="account-cancel" onClick={() => run('cancel', api.cancel)}>
                {t('account.cancel')}
              </button>
            </div>
          ) : (
            <div className="ac-row">
              <button type="button" className="ck-btn ck-btn--primary" data-testid="account-sign-in" disabled={!view.configured || busy === 'signin'} onClick={() => run('signin', api.signIn)}>
                {t('account.signIn')}
              </button>
            </div>
          )}
          {(error ?? view.message) && (
            <p className="ac-error" role="alert" data-testid="account-error">
              {error ?? view.message}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="ac-line" data-testid="account-as">
            {t('account.signedInAs', { name: view.account?.display_name ?? '' })}
          </p>
          {fresh.map((d) => (
            <div key={d.id} className="ac-banner" role="status" data-testid="account-new-device">
              <span>
                {t('account.newDevice')} · <b>{d.name}</b>
              </span>
              <span className="ac-actions">
                <button
                  type="button"
                  className="ck-btn"
                  data-testid="account-not-me"
                  disabled={busy === `notme:${d.id}`}
                  onClick={() => run(`notme:${d.id}`, () => api.revoke(d.id, 'not_me'), () => setWarned(true))}
                >
                  {t('account.notMe')}
                </button>
                <button type="button" className="ck-btn" data-testid="account-its-me" onClick={() => dismiss(d.id)}>
                  {t('account.itsMe')}
                </button>
              </span>
            </div>
          ))}
          {warned && (
            <p className="ac-note" role="status" data-testid="account-not-me-advice">
              {t('account.notMeAdvice')}
            </p>
          )}
          <h3 className="ac-h3">{t('account.devices')}</h3>
          <ul className="ac-list" data-testid="account-devices">
            {devices.map((d) => (
              <li key={d.id} className={`ac-item${d.revoked ? ' is-gone' : ''}`} data-testid={`account-device-${d.id}`}>
                <span className={`ac-dot${d.online && !d.revoked ? ' is-up' : ''}`} aria-hidden="true" />
                <span className="ac-grow">
                  <b>{d.name}</b>
                  <small>
                    {d.kind === 'phone' ? t('account.kindPhone') : t('account.kindPc')} · {seen(t, d, nowSecs)}
                  </small>
                </span>
                {d.is_this && <span className="ac-chip">{t('account.thisDevice')}</span>}
                {!d.revoked && (
                  <button
                    type="button"
                    className="ck-btn"
                    data-testid={`account-sign-out-${d.id}`}
                    disabled={busy === `out:${d.id}`}
                    onClick={() => run(`out:${d.id}`, () => (d.is_this ? api.signOutHere() : api.revoke(d.id, 'sign_out')))}
                  >
                    {d.is_this ? t('account.signOutThis') : t('account.signOutOther')}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="ac-note">{t('account.promise')}</p>
          {(error ?? view.message) && (
            <p className="ac-error" role="alert" data-testid="account-error">
              {error ?? view.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
