// Connect > Devices > "My phone". Phones only, in phone words. It never shares a sheet, a list or a sentence with "My PCs".
//   no phone yet   the giant code in the middle of the page (scan it; the phone shows up here by itself)
//   phones added   one row per phone ("Can watch, answer and send messages") and an "Add a phone" button that opens a sheet with the code
// A phone's own sheet: its name (click to rename), one switch for starting agents and changing things (off), and Remove.
import { DEVICE_CAPS, type DeviceCap, type PairedDeviceInfo } from '@potato-workspace/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { DEVICE_NAMES_CHANGED } from '../../lib/deviceNames';
import { errorSentence } from '../../lib/sayError';
import { tauri } from '../../lib/tauri';
import { DEVICES_CHANGED_EVENT } from '../MobilePairingPanel';
import type { TunnelApi } from '../settings/TunnelSection';
import { SimplePhone } from './SimplePhone';

/** What a phone's own sheet changes. Tests pass fakes; the app uses the real commands. */
export interface PhoneApi {
  setCaps: (id: string, caps: DeviceCap[]) => Promise<unknown>;
  rename: (id: string, name: string) => Promise<unknown>;
  revoke: (id: string) => Promise<unknown>;
}

export const defaultPhoneApi: PhoneApi = {
  setCaps: (id, caps) => tauri.setPairedMobileDeviceCaps(id, caps),
  rename: (id, name) => tauri.renamePairedMobileDevice(id, name),
  revoke: (id) => tauri.revokePairedMobileDevice(id),
};

const capsOf = (d: PairedDeviceInfo): DeviceCap[] => d.caps ?? [...DEVICE_CAPS];

/** What a phone may do besides starting things: the plain level choice of its sheet (the code gives the last one). */
export type PhoneLevel = 'watch' | 'answer' | 'send';
const LEVEL_CAPS: Record<PhoneLevel, DeviceCap[]> = { watch: ['watch'], answer: ['watch', 'answer'], send: ['watch', 'answer', 'type'] };
const levelOf = (caps: DeviceCap[]): PhoneLevel => (caps.includes('type') ? 'send' : caps.includes('answer') ? 'answer' : 'watch');

export function PhoneGroup({
  tunnel,
  listPhones,
  phoneApi = defaultPhoneApi,
  publicPwaUrl,
  devServerPort,
  ready,
  active,
  waiting,
}: {
  tunnel: TunnelApi;
  listPhones: () => Promise<PairedDeviceInfo[]>;
  phoneApi?: PhoneApi;
  publicPwaUrl: string;
  devServerPort: unknown;
  ready: boolean;
  /** The Devices tab is on screen: the code is made only then. */
  active: boolean;
  /** This PC cannot be reached right now, so the phones say they are waiting for it. */
  waiting: boolean;
}) {
  const t = useT();
  const [phones, setPhones] = useState<PairedDeviceInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      listPhones()
        .then((p) => alive && setPhones(p.filter((d) => !d.expired)))
        .catch(() => alive && setPhones([]));
    load();
    window.addEventListener(DEVICES_CHANGED_EVENT, load);
    // A phone that scans the code shows up by itself.
    const timer = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(DEVICES_CHANGED_EVENT, load);
    };
  }, [listPhones]);
  const count = phones?.length ?? 0;
  // The first phone just connected: the code that was open in the sheet has done its job.
  useEffect(() => {
    if (count === 0) setOpenId(null);
  }, [count]);
  const open = phones?.find((p) => p.id === openId) ?? null;
  const code = (giant: boolean, on: boolean) => (
    <SimplePhone tunnel={tunnel} phones={phones === null ? null : count} publicPwaUrl={publicPwaUrl} devServerPort={devServerPort} ready={ready} paused={!on} giant={giant} />
  );
  return (
    <section className="cx-group" data-testid="connect-phone-group" aria-label={t('connect.phone.title')}>
      <div className="cx-ghead">
        <h2>{t('connect.phone.title')}</h2>
        {count > 0 && (
          <button type="button" className="cx-btn" data-testid="connect-add-phone" onClick={() => setAdding(true)}>
            {t('connect.phone.add')}
          </button>
        )}
      </div>
      {phones === null && <p className="cx-note">…</p>}
      {phones !== null && count === 0 && (
        <div className="cx-hero" data-testid="connect-phone-hero">
          {code(true, active && !adding)}
        </div>
      )}
      {count > 0 && (
        <ul className="cx-list" data-testid="connect-phone-list">
          {phones!.map((p) => (
            <li key={p.id} className="cx-row" data-testid={`connect-phone-${p.id}`}>
              <span className={`cx-dot${waiting ? '' : ' ok'}`} aria-hidden="true" />
              <div className="cx-main">
                <button type="button" className="cx-namebtn" onClick={() => setOpenId(p.id)}>
                  {p.name}
                </button>
                <div className="cx-sub">{waiting ? t('connect.phone.waiting') : capsOf(p).includes('control') ? t('connect.phone.canMore') : t('connect.phone.can')}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <PhoneSheet title={t('connect.phone.add')} onClose={() => setAdding(false)} testId="connect-add-phone-sheet">
          {code(true, active)}
        </PhoneSheet>
      )}
      {open && <PhoneDetails phone={open} api={phoneApi} onClose={() => setOpenId(null)} />}
    </section>
  );
}

/** The side sheet of the phone group. */
function PhoneSheet({ title, onClose, testId, children }: { title: string; onClose: () => void; testId: string; children: ReactNode }) {
  const t = useT();
  return (
    <div className="cx-scrim" data-testid={testId}>
      <div className="cx-sheet" role="dialog" aria-label={title}>
        <div className="cx-sheet-head">
          <h3>{title}</h3>
          <button type="button" className="cx-btn cx-quiet" aria-label={t('connect.close')} onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PhoneDetails({ phone, api, onClose }: { phone: PairedDeviceInfo; api: PhoneApi; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(phone.name);
  const [asking, setAsking] = useState<'more' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const more = capsOf(phone).includes('control');
  const run = (p: Promise<unknown>) => p.then(() => setError(null)).catch((e: unknown) => setError(errorSentence(e)));
  const refresh = () => window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
  const setMore = (on: boolean) =>
    run(api.setCaps(phone.id, DEVICE_CAPS.filter((c) => (c === 'control' ? on : capsOf(phone).includes(c)))).then(refresh)).finally(() => setAsking(null));
  const level = levelOf(capsOf(phone));
  const setLevel = (next: PhoneLevel) => {
    const caps = DEVICE_CAPS.filter((c) => LEVEL_CAPS[next].includes(c) || (c === 'control' && more));
    void run(api.setCaps(phone.id, caps).then(refresh));
  };
  const save = () => {
    const next = name.trim();
    if (next === '' || next === phone.name) return;
    void run(api.rename(phone.id, next).then(() => (window.dispatchEvent(new Event(DEVICE_NAMES_CHANGED)), refresh())));
  };
  return (
    <PhoneSheet title={t('connect.phone.sheetTitle')} onClose={onClose} testId="connect-phone-sheet">
      <input
        className="cx-input"
        type="text"
        value={name}
        maxLength={60}
        aria-label={t('connect.phone.name')}
        data-testid="connect-phone-name"
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      <div className="cx-levels" role="radiogroup" aria-label={t('connect.phone.levelLabel')} data-testid="connect-phone-level">
        {(['watch', 'answer', 'send'] as PhoneLevel[]).map((l) => (
          <label key={l} className="cx-level">
            <input type="radio" name={`phone-level-${phone.id}`} checked={level === l} data-testid={`connect-phone-level-${l}`} onChange={() => setLevel(l)} />
            <span>{t(`connect.phone.level.${l}`)}</span>
          </label>
        ))}
      </div>
      <div className="cx-switchrow">
        <div>
          <b>{t('connect.phone.moreLabel')}</b>
          <div className="cx-note">{more ? t('connect.phone.moreOn') : t('connect.phone.moreOff')}</div>
        </div>
        <label className="cx-switch">
          <input type="checkbox" role="switch" checked={more} aria-label={t('connect.phone.moreLabel')} data-testid="connect-phone-more" disabled={level === 'watch' && !more} onChange={(e) => (e.target.checked ? setAsking('more') : void setMore(false))} />
          <span aria-hidden="true" />
        </label>
      </div>
      {asking === 'more' && (
        <div className="cx-confirm" role="alertdialog" data-testid="connect-phone-more-confirm">
          <p>{t('connect.phone.moreAsk')}</p>
          <div className="cx-row-actions">
            <button type="button" className="cx-btn cx-primary" data-testid="connect-phone-more-yes" onClick={() => void setMore(true)}>
              {t('connect.phone.moreYes')}
            </button>
            <button type="button" className="cx-btn" onClick={() => setAsking(null)}>
              {t('connect.phone.moreNo')}
            </button>
          </div>
        </div>
      )}
      {asking === 'remove' ? (
        <div className="cx-confirm" role="alertdialog" data-testid="connect-phone-remove-confirm">
          <p>{t('connect.phone.removeAsk', { name: phone.name })}</p>
          <div className="cx-row-actions">
            <button type="button" className="cx-btn cx-primary" data-testid="connect-phone-remove-yes" onClick={() => void run(api.revoke(phone.id).then(refresh)).then(onClose)}>
              {t('connect.phone.removeYes')}
            </button>
            <button type="button" className="cx-btn" onClick={() => setAsking(null)}>
              {t('connect.phone.removeNo')}
            </button>
          </div>
        </div>
      ) : (
        <div className="cx-row-actions">
          <button type="button" className="cx-btn" data-testid="connect-phone-remove" onClick={() => setAsking('remove')}>
            {t('connect.phone.remove')}
          </button>
          <button type="button" className="cx-btn cx-quiet" onClick={onClose}>
            {t('connect.close')}
          </button>
        </div>
      )}
      {error && (
        <p className="cx-error" role="alert">
          {error}
        </p>
      )}
    </PhoneSheet>
  );
}
