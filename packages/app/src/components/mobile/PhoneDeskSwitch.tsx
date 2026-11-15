// "Leaving my desk" on the phone: the same switch as the PC's status bar, over the bridge (`GET/POST /desk-away`, `POST /desk-away/back`).
// Reading it needs `watch`; switching it on or off needs `control`. A switch flipped here turns push on and can lock the PC's screen
// control, but it never raises what the PC kept to itself: the PC's own switch does that. The bridge's sign-in is unchanged.
import { useCallback, useEffect, useState } from 'react';
import { useLanguage, useT } from '../../i18n';
import { DESK_LENGTHS, isAway, NOT_AWAY, type DeskAway, type DeskLength, type DeskPhoneApi } from '../../lib/desk-away';
import { ngrokRequestHeaders } from '../../lib/bridge-ngrok';
import { localSecretHeaders } from '../../lib/bridge-local-secret';
import { mergeBridgeHeaders } from '../../lib/mobile-pairing-auth';
import '../../styles/phone-shell.css';

/** The three calls, with the same headers as the bridge client. */
export function bridgeDeskApi(baseUrl: string): DeskPhoneApi {
  const headers = (): Record<string, string> => mergeBridgeHeaders({ ...ngrokRequestHeaders(baseUrl), ...localSecretHeaders(baseUrl) });
  const send = async (path: string, body: unknown): Promise<DeskAway> => {
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`bridge POST ${path} -> ${res.status}`);
    return (await res.json()) as DeskAway;
  };
  return {
    get: async () => {
      const res = await fetch(`${baseUrl}/desk-away`, { headers: headers() });
      // An older PC has no such route: the card simply does not show.
      if (res.status === 404) return NOT_AWAY;
      if (!res.ok) throw new Error(`bridge GET /desk-away -> ${res.status}`);
      return (await res.json()) as DeskAway;
    },
    start: (length, lockScreen) => send('/desk-away', { length, lock_screen: lockScreen }),
    back: () => send('/desk-away/back', {}),
  };
}

/** The read repeats this often while the card is up (the PC may end it, or its time may run out). */
const REFRESH_MS = 15_000;

export function PhoneDeskSwitch({ api, canControl, refreshKey = 0 }: { api: DeskPhoneApi; canControl: boolean; refreshKey?: number }) {
  const t = useT();
  const lang = useLanguage();
  const [state, setState] = useState<DeskAway | null>(null);
  const [length, setLength] = useState<DeskLength>('until_back');
  const [lock, setLock] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const read = useCallback(() => {
    api.get().then(setState, () => undefined);
  }, [api]);
  useEffect(() => {
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [read, refreshKey]);

  const run = (action: () => Promise<DeskAway>) => {
    setBusy(true);
    setFailed(false);
    action().then(
      (next) => {
        setState(next);
        setOpen(false);
        setBusy(false);
      },
      () => {
        setFailed(true);
        setBusy(false);
      },
    );
  };

  // Nothing to show until the PC answered, and a person who may only watch gets the state but no buttons.
  if (!state) return null;
  const away = isAway(state);
  if (!away && !canControl) return null;
  const until = state.until_ms == null ? t('desk.untilBack') : t('desk.until', { time: new Date(state.until_ms).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' }) });

  return (
    <section className="ph-desk" data-testid="phone-desk" data-away={away || undefined} aria-label={t('desk.phone.title')}>
      <b>{t('desk.phone.title')}</b>
      {away ? (
        <>
          <p>{t('desk.phone.on')}</p>
          <p className="ph-desk-sub">{[until, state.lock_screen ? t('desk.locked') : null].filter(Boolean).join(' · ')}</p>
          {state.by !== 'pc' && <p className="ph-desk-sub">{t('desk.phone.keeps')}</p>}
          {canControl && (
            <button type="button" className="ph-desk-btn" onClick={() => run(() => api.back())} disabled={busy} data-testid="phone-desk-back">
              {t('desk.phone.back')}
            </button>
          )}
        </>
      ) : !open ? (
        <>
          <p>{t('desk.phone.intro')}</p>
          <button type="button" className="ph-desk-btn" onClick={() => setOpen(true)} data-testid="phone-desk-open">
            {t('desk.phone.start')}
          </button>
        </>
      ) : (
        <>
          <fieldset className="ph-desk-lengths">
            <legend>{t('desk.how')}</legend>
            {DESK_LENGTHS.map((l) => (
              <label key={l}>
                <input type="radio" name="phone-desk-length" checked={length === l} onChange={() => setLength(l)} />
                <span>{t(`desk.len.${l}`)}</span>
              </label>
            ))}
          </fieldset>
          <label className="ph-desk-lock">
            <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
            <span>{t('desk.phone.lock')}</span>
          </label>
          <button type="button" className="ph-desk-btn" onClick={() => run(() => api.start(length, lock))} disabled={busy} data-testid="phone-desk-go">
            {t('desk.phone.start')}
          </button>
        </>
      )}
      {failed && (
        <p className="ph-desk-sub" role="alert">
          {t('desk.phone.failed')}
        </p>
      )}
    </section>
  );
}
