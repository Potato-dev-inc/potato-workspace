// Connect > Devices > "My PCs". PCs only, in PC words. It never shares a sheet, a list or a sentence with "My phone".
//   - PCs signed in to the same account list themselves, each with Open (or what to do first: "Press Allow on REN-WORK first").
//   - "Add a PC": one friendly link (copied when made), or paste one you were given. A PC on the same account needs nothing.
//   - The first time, the six digits are typed on the PC being opened (the existing number sheets): the account only says who is who.
//   - A PC's own sheet holds ONE switch, "Can work on this PC", off until you turn it on and say yes. Everything else is watch and answer.
// Open jumps to that PC's section in the sidebar through `onOpenPc` (the cockpit gives it when the sidebar has the sections);
// without it the Devices tab shows that PC's own page.
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Settings } from '@potato-workspace/shared';
import { useT } from '../../i18n';
import type { AccountPc, AccountPcsReply } from '../../lib/account';
import { deviceLabel, type Device, type DevicesApi } from '../../lib/devices';
import { DEVICE_NAMES_CHANGED } from '../../lib/deviceNames';
import { errorSentence } from '../../lib/sayError';
import type { SettingsPatch } from '../../lib/settings';
import { AccountPanel } from '../account/AccountPanel';
import { PairConfirm } from '../devices/PairConfirm';
import { useDevices } from '../devices/useDevices';
import { lockedUntilOf, lockTime } from './accountLock';
import type { ConnectApi } from './ConnectPage';
import '../../styles/account.css';
import '../../styles/devices.css';

/** How often the account's list is read again while the page is open (a PC that signs in shows up within this). */
const REFRESH_MS = 10_000;

interface PcRow {
  key: string;
  name: string;
  /** The PC's own sheet (paired PCs only). */
  device: Device | null;
  /** The account's entry, when this PC is on it. */
  account: AccountPc | null;
  online: boolean;
  line: string;
  canOpen: boolean;
  recent: boolean;
}

function seen(t: ReturnType<typeof useT>, lastSeen: number, nowSecs: number): string {
  const mins = Math.max(0, Math.floor((nowSecs - lastSeen) / 60));
  if (mins < 1) return t('connect.pc.online');
  if (mins < 60) return t('connect.pc.seenMinutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t('connect.pc.seenHours', { count: hours });
  return t('connect.pc.seenDays', { count: Math.floor(hours / 24) });
}

export function PcGroup({
  api,
  settings,
  patch,
  onOpenPc,
  waiting,
  needsUpdate = false,
  onUpdate,
  now = () => Math.floor(Date.now() / 1000),
}: {
  api: ConnectApi;
  settings: Settings | null;
  patch: (p: SettingsPatch) => Promise<void>;
  /** Show that PC (its section in the sidebar). Answer false when it cannot (no section yet): its own sheet opens instead. */
  onOpenPc: (node: string) => boolean | void;
  /** This PC cannot be reached right now, so the PCs say they are waiting for it. */
  waiting: boolean;
  /** This PC's link cannot add PCs on other networks yet: the same sentence and one Update button show here as on the This PC row. */
  needsUpdate?: boolean;
  onUpdate?: () => void;
  now?: () => number;
}) {
  const t = useT();
  const { view, enabled, refresh } = useDevices(api.devices);
  const [reply, setReply] = useState<AccountPcsReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // The account route is paused (here or at the other PC): the time it ends, in unix ms (0: the time cannot be read).
  const [pausedUntil, setPausedUntil] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [sheetNode, setSheetNode] = useState<string | null>(null);
  const [notNow, setNotNow] = useState(false);
  const alive = useRef(true);
  const account = api.account;
  const off = settings !== null && settings.devices_enabled !== true && !enabled;

  const accountOn = settings?.account_enabled === true;
  const readPcs = useCallback(() => {
    if (!account.pcs || !accountOn) return;
    account
      .pcs()
      .then((r) => {
        if (!alive.current) return;
        setReply(r);
        if (r.message) setError(r.message);
      })
      .catch(() => alive.current && setError(t('connect.pc.listFailed')));
  }, [account, accountOn, t]);
  useEffect(() => {
    alive.current = true;
    readPcs();
    let stop: (() => void) | null = null;
    void account.onChanged(readPcs).then((un) => {
      if (alive.current) stop = un;
      else un();
    });
    const timer = window.setInterval(readPcs, REFRESH_MS);
    return () => {
      alive.current = false;
      stop?.();
      window.clearInterval(timer);
    };
  }, [account, readPcs]);

  const listed = reply && reply.available && reply.signed_in ? reply : null;
  const nowSecs = now();
  const rows = useMemo<PcRow[]>(() => {
    const out: PcRow[] = [];
    const byNode = new Map((view?.devices ?? []).map((d) => [d.node, d]));
    const covered = new Set<string>();
    for (const pc of listed?.pcs ?? []) {
      const device = pc.node ? (byNode.get(pc.node) ?? null) : null;
      if (pc.node && pc.status !== 'new' && pc.status !== 'allow_there' && pc.status !== 'conflict' && pc.status !== 'lookalike') covered.add(pc.node);
      const line = waiting
        ? t('connect.pc.waiting')
        : pc.status === 'allow_there'
          ? pc.online
            ? t('connect.pc.allowThere', { name: pc.name })
            : seen(t, pc.last_seen_at, nowSecs)
          : pc.status === 'conflict'
            ? t('connect.pc.conflict')
            : pc.status === 'lookalike'
              ? t('connect.pc.lookalike')
              : pc.status === 'not_allowed'
                ? t('connect.pc.notAllowed')
                : pc.status === 'new'
                  ? pc.online
                    ? t('connect.pc.first')
                    : seen(t, pc.last_seen_at, nowSecs)
                  : pc.status === 'online'
                    ? t('connect.pc.online')
                    : seen(t, pc.last_seen_at, nowSecs);
      out.push({
        key: `a-${pc.id}`,
        name: pc.name,
        device,
        account: pc,
        online: pc.status === 'online' || (pc.online && pc.status !== 'allow_there'),
        line,
        canOpen: !waiting && pc.status !== 'allow_there' && pc.status !== 'conflict' && pc.status !== 'lookalike' && (pc.status !== 'new' || pc.online) && (pc.online || pc.status === 'online') && pc.node !== null,
        recent: pc.recent,
      });
    }
    for (const d of view?.devices ?? []) {
      if (covered.has(d.node)) continue;
      const on = d.state === 'online';
      out.push({
        key: `d-${d.node}`,
        name: deviceLabel(d),
        device: d,
        account: null,
        online: on,
        line: waiting ? t('connect.pc.waiting') : on ? (d.too_old ? t('connect.pc.tooOld') : t('connect.pc.online')) : d.last_seen !== null ? seen(t, d.last_seen, nowSecs) : t('connect.pc.offline'),
        canOpen: !waiting && on && !d.too_old,
        recent: false,
      });
    }
    return out;
  }, [listed, view, waiting, nowSecs, t]);

  const open = (row: PcRow) => {
    if (row.account) {
      const pc = row.account;
      if (!account.openPc) return;
      setOpening(pc.id);
      setError(null);
      setPausedUntil(null);
      account
        .openPc(pc.id)
        .then((r) => {
          if (alive.current && r.node && onOpenPc(r.node) === false) setSheetNode(r.node);
        })
        .catch((e: unknown) => {
          if (!alive.current) return;
          const until = lockedUntilOf(e);
          if (until !== null) setPausedUntil(until);
          else setError(typeof e === 'string' && e ? e : e instanceof Error && e.message ? e.message : t('connect.pc.openFailed'));
        })
        .finally(() => {
          if (!alive.current) return;
          setOpening(null);
          readPcs();
          refresh();
        });
      return;
    }
    if (row.device && onOpenPc(row.device.node) === false) setSheetNode(row.device.node);
  };
  const setAllow = (on: boolean) => {
    if (!account.setOpenHere) return;
    setError(null);
    account
      .setOpenHere(on)
      .catch(() => alive.current && setError(t('connect.pc.allowFailed')))
      .finally(() => alive.current && readPcs());
  };

  const sheetDevice = sheetNode ? (view?.devices.find((d) => d.node === sheetNode) ?? null) : null;

  if (off) {
    return (
      <section className="cx-group" data-testid="connect-pc-group" aria-label={t('connect.pc.title')}>
        <div className="cx-ghead">
          <h2>{t('connect.pc.title')}</h2>
        </div>
        {accountOn && <AccountPanel api={api.account} />}
        <div className="cx-row" data-testid="connect-pcs-off">
          <span className="cx-dot" aria-hidden="true" />
          <div className="cx-main">
            <div className="cx-name">{t('connect.pc.offTitle')}</div>
            <div className="cx-sub">{t('connect.pc.offLine')}</div>
          </div>
          <div className="cx-act">
            <button type="button" className="cx-btn" data-testid="connect-pcs-turn-on" onClick={() => void patch({ devices_enabled: true })}>
              {t('connect.pc.turnOn')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="cx-group" data-testid="connect-pc-group" aria-label={t('connect.pc.title')}>
      {view?.pending && <PairConfirm pending={view.pending} api={api.devices} />}
      <div className="cx-ghead">
        <h2>{t('connect.pc.title')}</h2>
        <button type="button" className="cx-btn" data-testid="connect-add-pc" onClick={() => setAdding(true)}>
          {t('connect.pc.add')}
        </button>
      </div>
      {accountOn && listed === null && <AccountPanel api={api.account} />}
      {(listed?.removed ?? []).map((r) => (
        <div key={r.id} className="cx-thin" role="status" data-testid={`connect-pc-removed-${r.id}`}>
          <span>{t('connect.pc.removed', { name: r.name || '?' })}</span>
          <button type="button" className="cx-link" onClick={() => void account.dismissRemoved?.(r.id).finally(() => alive.current && readPcs())}>
            {t('connect.pc.dismiss')}
          </button>
        </div>
      ))}
      {view?.tampered && (
        <p className="cx-error" role="alert">
          {t('connect.pc.tampered')}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="cx-note" data-testid="connect-pc-empty">
          {t('connect.pc.empty')}
        </p>
      ) : (
        <ul className="cx-list" data-testid="connect-pc-list">
          {rows.map((r) => (
            <li key={r.key} className="cx-row" data-testid={r.account ? `account-pc-${r.account.id}` : `device-${r.device?.node}`} data-status={r.account?.status ?? 'paired'}>
              <span className={`cx-dot${r.online && !waiting ? ' ok' : ''}`} aria-hidden="true" />
              <div className="cx-main">
                {r.device ? (
                  <button type="button" className="cx-namebtn" data-testid={`connect-pc-name-${r.device.node}`} onClick={() => setSheetNode(r.device!.node)}>
                    {r.name}
                  </button>
                ) : (
                  <div className="cx-name">{r.name}</div>
                )}
                <div className="cx-sub" data-testid={r.account ? `account-pc-line-${r.account.id}` : undefined}>
                  {opening !== null && opening === r.account?.id ? t('connect.pc.opening') : r.line}
                  {r.recent && <span className="cx-chip"> · {t('connect.pc.recent')}</span>}
                </div>
              </div>
              <div className="cx-act">
                {r.canOpen && (
                  <button type="button" className="cx-btn" data-testid={r.account ? `account-pc-open-${r.account.id}` : `connect-pc-open-${r.device?.node}`} disabled={opening !== null && opening === r.account?.id} onClick={() => open(r)}>
                    {t('connect.pc.open')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {listed && listed.pcs.length > 0 && !listed.open_here && !notNow && (
        <div className="cx-thin" role="group" data-testid="connect-pc-allow-ask">
          <span>{t('connect.pc.allowAsk')}</span>
          <button type="button" className="cx-btn" data-testid="connect-pc-allow" onClick={() => setAllow(true)}>
            {t('connect.pc.allow')}
          </button>
          <button type="button" className="cx-link" onClick={() => setNotNow(true)}>
            {t('connect.pc.notNow')}
          </button>
        </div>
      )}
      {listed && (
        <div className="cx-switchrow" data-testid="connect-pc-askrow">
          <span>{t('connect.pc.askLabel')}</span>
          <span className="cx-switchside">
            <span className="cx-faint">{listed.open_here ? t('connect.on') : t('connect.off')}</span>
            <label className="cx-switch">
              <input type="checkbox" role="switch" checked={listed.open_here} aria-label={t('connect.pc.askLabel')} data-testid="account-pcs-tick" onChange={(e) => setAllow(e.target.checked)} />
              <span aria-hidden="true" />
            </label>
          </span>
        </div>
      )}
      {accountOn && listed !== null && <AccountPanel api={api.account} compact />}
      {pausedUntil !== null && (
        <div className="cx-error" role="alert" data-testid="account-pcs-paused">
          <p>{pausedUntil > 0 ? t('account.pcs.pausedUntil', { time: lockTime(pausedUntil) }) : t('account.pcs.pausedGeneric')}</p>
          <p>{t('account.pcs.pausedNext')}</p>
        </div>
      )}
      {error && (
        <p className="cx-error" role="alert" data-testid="account-pcs-error">
          {error}
        </p>
      )}
      {adding && view && <AddPcSheet view={view} api={api.devices} hasAccount={listed !== null} needsUpdate={needsUpdate} onUpdate={() => (setAdding(false), onUpdate?.())} onClose={() => setAdding(false)} onJoined={() => (setAdding(false), refresh())} />}
      {sheetDevice && <PcDetails device={sheetDevice} api={api.devices} onChanged={refresh} onClose={() => setSheetNode(null)} />}
    </section>
  );
}

/** The side sheet of the PC group. */
function PcSheet({ title, onClose, testId, children }: { title: string; onClose: () => void; testId: string; children: ReactNode }) {
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

function AddPcSheet({ view, api, hasAccount, needsUpdate, onUpdate, onClose, onJoined }: { needsUpdate: boolean; onUpdate: () => void; view: { hosting: { kind: string; link?: string | null; worker?: boolean } | null; joining: string | null }; api: DevicesApi; hasAccount: boolean; onClose: () => void; onJoined: () => void }) {
  const t = useT();
  const [made, setMade] = useState<string | null>(null);
  const [viaLink, setViaLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [picture, setPicture] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);
  const hosted = view.hosting?.kind === 'link' ? (view.hosting.link ?? null) : null;
  const link = hosted ?? made;
  const viaRelay = hosted ? view.hosting?.worker === true : viaLink;
  // A link that was made here is withdrawn when the sheet goes away.
  useEffect(
    () => () => {
      if (asked.current) api.cancelCode().catch(() => undefined);
    },
    [api],
  );
  useEffect(() => {
    if (!link) return;
    let live = true;
    try {
      // Black on white always: a camera reads that best, in both themes.
      QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'L', color: { dark: '#000000', light: '#ffffff' } })
        .then((svg) => live && setPicture(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`))
        .catch(() => live && setPicture(null));
    } catch {
      /* no picture is not a problem: Copy still works */
    }
    return () => {
      live = false;
    };
  }, [link]);
  const copy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
    } catch {
      /* no clipboard here */
    }
  };
  const make = () => {
    setError(null);
    asked.current = true;
    api
      .makeLink()
      .then((v) => {
        const l = v.hosting?.kind === 'link' ? (v.hosting.link ?? null) : null;
        setMade(l);
        setViaLink(v.hosting?.worker === true);
        // The link is copied by itself, so there is nothing to select.
        if (l) copy(l);
      })
      .catch((e: unknown) => setError(errorSentence(e)));
  };
  const join = () => {
    setBusy(true);
    setError(null);
    api
      .joinLink(pasted.trim())
      .then(onJoined)
      .catch((e: unknown) => {
        setError(errorSentence(e));
        setBusy(false);
      });
  };
  return (
    <PcSheet title={t('connect.pc.addTitle')} onClose={onClose} testId="connect-add-pc-sheet">
      {hasAccount && <p className="cx-lead">{t('connect.pc.addAccount')}</p>}
      <p className="cx-note">{t('connect.pc.addOther')}</p>
      {needsUpdate && (
        <p className="cx-note" data-testid="connect-pc-needs-update">
          {t('connect.thisPc.update')}{' '}
          <button type="button" className="cx-link" data-testid="connect-pc-update-go" onClick={onUpdate}>
            {t('connect.thisPc.updateGo')}
          </button>
        </p>
      )}
      {link ? (
        <div className="cx-linkmade" data-testid="connect-pc-link">
          {picture && <img className="cx-qr" src={picture} alt={t('connect.pc.linkQr')} width={140} height={140} data-testid="connect-pc-link-qr" />}
          <div>
            <p className="cx-lead">{copied ? t('connect.pc.linkCopied') : t('connect.pc.linkMade')}</p>
            <button type="button" className="cx-btn" data-testid="connect-pc-link-copy" onClick={() => copy(link)}>
              {t('connect.pc.copyLink')}
            </button>
            {!needsUpdate && (
              <p className="cx-note" data-testid={viaRelay ? 'connect-pc-link-anywhere' : 'connect-pc-link-near'}>
                {viaRelay ? t('connect.pc.linkAnywhere') : t('connect.pc.linkNear')}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="cx-row-actions">
          <button type="button" className="cx-btn cx-primary" data-testid="connect-pc-make-link" onClick={make}>
            {t('connect.pc.makeLink')}
          </button>
          <button type="button" className="cx-btn cx-quiet" onClick={onClose}>
            {t('connect.pc.notNow')}
          </button>
        </div>
      )}
      <label className="cx-field">
        <span>{t('connect.pc.pasteLabel')}</span>
        <input type="text" className="cx-input" value={pasted} placeholder={t('connect.pc.pastePlaceholder')} data-testid="connect-pc-paste" onChange={(e) => setPasted(e.target.value)} />
      </label>
      {pasted.trim() !== '' && (
        <div className="cx-row-actions">
          <button type="button" className="cx-btn cx-primary" disabled={busy} data-testid="connect-pc-join" onClick={join}>
            {busy ? t('connect.pc.joining') : t('connect.pc.join')}
          </button>
        </div>
      )}
      {busy && view.joining && <p className="cx-note">{view.joining}</p>}
      {error && (
        <p className="cx-error" role="alert">
          {error}
        </p>
      )}
    </PcSheet>
  );
}

function PcDetails({ device, api, onChanged, onClose }: { device: Device; api: DevicesApi; onChanged: () => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(device.name);
  const [asking, setAsking] = useState<'work' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const work = device.lets_run && device.level === 'full';
  const run = (p: Promise<unknown>) =>
    p
      .then(() => (setError(null), onChanged()))
      .catch((e: unknown) => setError(errorSentence(e)))
      .finally(() => setAsking(null));
  const turnOff = async () => {
    await api.setPermission(device.node, false, 'watch');
    if (device.lets_files) await api.setFiles(device.node, false);
  };
  const save = () => {
    const next = name.trim();
    if (next === '' || next === device.name) return;
    void run(api.rename(device.node, next).then(() => window.dispatchEvent(new Event(DEVICE_NAMES_CHANGED))));
  };
  return (
    <PcSheet title={t('connect.pc.sheetTitle')} onClose={onClose} testId="connect-pc-sheet">
      <input
        className="cx-input"
        type="text"
        value={name}
        maxLength={40}
        aria-label={t('connect.pc.name')}
        data-testid="connect-pc-name"
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      <p className="cx-note">{t('connect.pc.canWatch')}</p>
      <div className="cx-switchrow">
        <div>
          <b>{t('connect.pc.workLabel')}</b>
          <div className="cx-note">{work ? t('connect.pc.workOn') : t('connect.pc.workOff')}</div>
        </div>
        <label className="cx-switch">
          <input
            type="checkbox"
            role="switch"
            checked={work}
            aria-label={t('connect.pc.workLabel')}
            data-testid="connect-pc-work"
            // Off puts the PC back to its default: nothing that starts agents, uses the terminal or changes files is left on.
            onChange={(e) => (e.target.checked ? setAsking('work') : void run(turnOff()))}
          />
          <span aria-hidden="true" />
        </label>
      </div>
      {asking === 'work' && (
        <div className="cx-confirm" role="alertdialog" data-testid="connect-pc-work-confirm">
          <p>{t('connect.pc.workAsk')}</p>
          <div className="cx-row-actions">
            <button type="button" className="cx-btn cx-primary" data-testid="connect-pc-work-yes" onClick={() => void run(api.setPermission(device.node, true, 'full'))}>
              {t('connect.pc.workYes')}
            </button>
            <button type="button" className="cx-btn" onClick={() => setAsking(null)}>
              {t('connect.pc.workNo')}
            </button>
          </div>
        </div>
      )}
      {asking === 'remove' ? (
        <div className="cx-confirm" role="alertdialog" data-testid="connect-pc-remove-confirm">
          <p>{t('connect.pc.removeAsk', { name: device.name })}</p>
          <div className="cx-row-actions">
            <button type="button" className="cx-btn cx-primary" data-testid="connect-pc-remove-yes" onClick={() => void run(api.remove(device.node)).then(onClose)}>
              {t('connect.pc.removeYes')}
            </button>
            <button type="button" className="cx-btn" onClick={() => setAsking(null)}>
              {t('connect.pc.removeNo')}
            </button>
          </div>
        </div>
      ) : (
        <div className="cx-row-actions">
          <button type="button" className="cx-btn" data-testid="connect-pc-remove" onClick={() => setAsking('remove')}>
            {t('connect.pc.remove')}
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
    </PcSheet>
  );
}
