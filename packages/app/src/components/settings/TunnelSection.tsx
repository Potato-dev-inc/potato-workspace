// Settings > Mobile PWA > Public address: pick how the phone reaches this computer.
import { errorSentence } from '../../lib/sayError';
import { useT } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { DomainBookFiles, TunnelConfigInput, TunnelConnectionTest, TunnelStatus } from '../../lib/tauri-types';
import { FieldInput, FieldLabel } from './settings-ui';
import { SecretValue } from './SecretValue';
import {
  MODE_LABELS,
  draftFromConfig,
  draftProblem,
  isStableMode,
  statusLine,
  toInput,
  type TunnelDraft,
} from './tunnel-model';

export interface TunnelApi {
  getStatus: () => Promise<TunnelStatus | null>;
  save: (input: TunnelConfigInput) => Promise<TunnelStatus>;
  /** `tryAnyway`: skip the wait after a refused restart (never after Cloudflare's own limit). */
  restart: (tryAnyway?: boolean) => Promise<TunnelStatus>;
  test: () => Promise<TunnelConnectionTest>;
  /** Delete the fixed phone address (OpenTunnel) everywhere. */
  forget?: () => Promise<TunnelStatus>;
  /** "Temporary link" (true) or "Permanent link" (false). */
  setTemporary?: (on: boolean) => Promise<TunnelStatus>;
  /** Choose the permanent, temporary or own-domain link. A typed domain stays saved whichever is chosen. */
  setLinkMode?: (mode: 'permanent' | 'temporary' | 'domain', domain?: string | null, route?: 'book' | 'direct' | null) => Promise<TunnelStatus>;
  /** The port the phone server on this PC asks for first (null = automatic). Takes effect after a restart. */
  setPhonePort?: (port: number | null) => Promise<TunnelStatus>;
  /** "Check": does this address really reach this PC? */
  checkDomain?: (address: string) => Promise<TunnelConnectionTest>;
  /** "My domain" + Address book: the Worker files to copy onto the person's own Cloudflare. */
  domainBookFiles?: (domain: string) => Promise<DomainBookFiles>;
}

const defaultApi: TunnelApi = {
  getStatus: () => tauri.getTunnelStatus(),
  save: (input) => tauri.setTunnelConfig(input),
  restart: (tryAnyway) => tauri.restartTunnel(tryAnyway),
  test: () => tauri.testTunnelConnection(),
  forget: () => tauri.forgetOpenTunnelAddress(),
  setTemporary: (on) => tauri.setLinkTemporary(on),
  setLinkMode: (mode, domain, route) => tauri.setLinkMode(mode, domain, route),
  setPhonePort: (port) => tauri.setPhonePort(port),
  checkDomain: (address) => tauri.checkOwnDomain(address),
  domainBookFiles: (domain) => tauri.domainBookFiles(domain),
};

const DOT: Record<string, string> = {
  ok: 'bg-neutral-200',
  wait: 'bg-neutral-500 animate-pulse',
  bad: 'border border-neutral-300 bg-transparent',
  idle: 'bg-neutral-600',
};

const LINK_POLL_MS = 1500;
const LINK_POLL_LIMIT = 40;

const buttonClass =
  'rounded-lg border border-pm-border px-3 py-1.5 text-xs hover:bg-pm-border/40 disabled:opacity-50';

/** Where to point an own domain or named tunnel: the port this running app really serves (never a guess), with a copy button. */
function LocalAddress({ status }: { status: TunnelStatus | null }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const port = status?.local_port ?? null;
  if (!status) return null;
  if (port == null) {
    return (
      <p className="mt-1 text-xs text-pm-muted" data-testid="tunnel-local-missing">
        {t('tunnel.localNotRunning')}
      </p>
    );
  }
  const url = `http://127.0.0.1:${port}`;
  return (
    <div className="mt-2" data-testid="tunnel-local">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>{t('tunnel.localAddress', { url: '' })}</span>
        <code className="font-mono" data-testid="tunnel-local-url">{url}</code>
        <button
          type="button"
          className={buttonClass}
          data-testid="tunnel-local-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? t('tunnel.localCopied') : t('tunnel.localCopy')}
        </button>
      </div>
      {status.port_problem === 'moved' && (
        <p className="mt-1 text-xs text-pm-muted" data-testid="tunnel-local-moved">{t('tunnel.localMoved')}</p>
      )}
    </div>
  );
}

export function TunnelSection({ api = defaultApi, openTunnelOn = false }: { api?: TunnelApi; /** The Labs switch `opentunnel_stable_link`. */ openTunnelOn?: boolean }) {
  const t = useT();
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [draft, setDraft] = useState<TunnelDraft>(draftFromConfig(null));
  const [busy, setBusy] = useState<'save' | 'restart' | 'test' | 'forget' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TunnelConnectionTest | null>(null);
  // The shared secret, shown only after it was made or after "Show secret"; never kept in the draft.
  const [revealed, setRevealed] = useState<string | null>(null);
  // "Make a new secret" was held back: why. Nothing was changed until the person confirms.
  const [strand, setStrand] = useState<string | null>(null);
  // The "Worker has another secret" card: the first secret being pasted (hidden by default), and the start-fresh confirm.
  const [pasted, setPasted] = useState('');
  const [pastedShown, setPastedShown] = useState(false);
  const [freshAsk, setFreshAsk] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.getStatus();
      setStatus(next);
      setDraft(draftFromConfig(next?.config));
    } catch (e) {
      setError(t('tunnel.readFailed', { reason: errorSentence(e) }));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Leaving the card forgets a revealed secret.
  useEffect(() => () => setRevealed(null), []);

  // While the tunnel is coming up, or the Worker link is still being made, poll so the status settles by itself.
  // Linking is bounded (about 60 s): after that a plain "still linking" note stays and polling stops.
  const linkPending = status?.state !== 'error' && (status?.stable?.link === 'waiting' || status?.stable?.link === 'linking');
  const polling = status?.state === 'starting' || linkPending;
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!polling) {
      setGaveUp(false);
      return;
    }
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
      if (ticks > LINK_POLL_LIMIT) {
        window.clearInterval(id);
        setGaveUp(true);
        return;
      }
      api
        .getStatus()
        .then((next) => next && setStatus(next))
        .catch((e: unknown) => setError(t('tunnel.checkFailed', { reason: errorSentence(e) })));
    }, LINK_POLL_MS);
    return () => window.clearInterval(id);
  }, [api, polling]);

  const run = async (kind: 'save' | 'restart' | 'test' | 'forget', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(null);
    }
  };

  const storedWorker = status?.config.mode === 'stable' ? status.config.url : null;
  const hasStoredSecret = Boolean(storedWorker) && status?.config.has_secret === true;
  const problem = draftProblem(draft, status?.config);
  const line = statusLine(status);

  // "Show secret" and "Make a new secret" save the stored Worker address with a secret action.
  const secretAction = (kind: 'show' | 'regenerate', confirmStrand = false) =>
    void run('save', async () => {
      if (!storedWorker) return;
      const next = await api.save({ mode: 'stable', worker_url: storedWorker, secret_action: kind, ...(confirmStrand ? { confirm_strand: true } : {}) });
      setStatus(next);
      setStrand(next.secret_not_reset && ['rejected', 'too_old', 'unreachable', 'update_app', 'too_many'].includes(next.secret_not_reset) ? next.secret_not_reset : next.secret_not_reset ? 'unreachable' : null);
      setRevealed(next.secret_once ?? null);
    });
  useEffect(() => {
    if (status?.stable?.secret_mismatch !== true) {
      setPasted('');
      setPastedShown(false);
      setFreshAsk(false);
    }
  }, [status?.stable?.secret_mismatch]);
  const mismatch = Boolean(storedWorker) && status?.stable?.secret_mismatch === true;
  const pastedProblem = pasted.trim().length > 0 && pasted.trim().length < 16;
  const usePasted = () =>
    void run('save', async () => {
      if (!storedWorker) return;
      const next = await api.save({ mode: 'stable', worker_url: storedWorker, secret: pasted.trim(), secret_action: 'keep' });
      setStatus(next);
      setPasted('');
      setPastedShown(false);
      setRevealed(null);
      setTest(null);
    });
  // Forget the saved link on this computer only; nothing on Cloudflare is touched.
  const startFresh = () =>
    void run('save', async () => {
      const next = await api.save({ mode: 'forget_worker' });
      setStatus(next);
      setDraft({ ...draftFromConfig(next.config), mode: 'stable', workerUrl: '', secret: '' });
      setPasted('');
      setFreshAsk(false);
      setStrand(null);
      setRevealed(null);
      setTest(null);
    });
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromConfig(status?.config));

  return (
    <section className="rounded-xl border border-pm-border bg-pm-panel p-4" aria-label={t('settings.row.tunnel.label')}>
      <h3 className="text-sm font-semibold">{t('settings.row.tunnel.label')}</h3>
      <p className="mt-1 text-sm leading-6 text-pm-muted">
        {t('tunnel.intro')}
      </p>

      <div className="mt-3 space-y-3">
        <div>
          <FieldLabel>{t('tunnel.how')}</FieldLabel>
          <select
            aria-label={t('tunnel.modeAria')}
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as TunnelDraft['mode'] })}
            className="w-full rounded-lg border border-pm-border bg-pm-bg px-3 py-2 text-sm outline-none"
          >
            {(Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[])
              // The third-party relay is a Labs option: shown when the switch is on, or when it is already the saved choice.
              .filter((mode) => mode !== 'open_tunnel' || openTunnelOn || status?.config.mode === 'open_tunnel')
              .map((mode) => (
              <option key={mode} value={mode}>
                {t(`tunnel.mode.${mode}`)}
              </option>
            ))}
          </select>
        </div>

        {draft.mode === 'named' && (
          <>
            <div>
              <FieldLabel>{t('tunnel.hostname')}</FieldLabel>
              <FieldInput
                aria-label={t('tunnel.hostnameAria')}
                placeholder="pm.example.com" // i18n-ok: example
                value={draft.hostname}
                onChange={(e) => setDraft({ ...draft, hostname: e.target.value })}
                className="font-mono"
              />
            </div>
            <div>
              <FieldLabel>{t('tunnel.token')}</FieldLabel>
              <FieldInput
                aria-label={t('tunnel.token')}
                type="password"
                autoComplete="off"
                placeholder={status?.config.has_token ? t('tunnel.tokenSaved') : t('tunnel.tokenPaste')}
                value={draft.token}
                onChange={(e) => setDraft({ ...draft, token: e.target.value })}
                className="font-mono"
              />
              <p className="mt-1 text-xs text-pm-muted">
                {t('tunnel.namedHelp')}
              </p>
              <LocalAddress status={status} />
            </div>
          </>
        )}

        {draft.mode === 'custom' && (
          <div>
            <FieldLabel>{t('tunnel.address')}</FieldLabel>
            <FieldInput
              aria-label={t('tunnel.customAria')}
              placeholder="https://pm.example.com" // i18n-ok: example
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              className="font-mono"
            />
            <p className="mt-1 text-xs text-pm-muted">
              {t('tunnel.customHelp')}
            </p>
            <LocalAddress status={status} />
          </div>
        )}

        {draft.mode === 'open_tunnel' && (
          <div data-testid="opentunnel-note">
            <p className="text-xs text-pm-muted">{t('tunnel.openTunnelHelp')}</p>
            {status?.config.mode === 'open_tunnel' && (
              <div className="mt-2">
                <button
                  type="button"
                  className={buttonClass}
                  data-testid="opentunnel-forget"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('forget', async () => {
                      if (!api.forget) return;
                      const next = await api.forget();
                      setStatus(next);
                      setDraft(draftFromConfig(next.config));
                      setTest(null);
                    })
                  }
                >
                  {busy === 'forget' ? t('tunnel.openTunnelForgetting') : t('tunnel.openTunnelForget')}
                </button>
                <p className="mt-1 text-xs text-pm-muted">{t('tunnel.openTunnelForgetHelp')}</p>
              </div>
            )}
          </div>
        )}

        {draft.mode === 'stable' && (
          <>
            <div>
              <FieldLabel>{t('tunnel.workerAddress')}</FieldLabel>
              <FieldInput
                aria-label={t('tunnel.workerAria')}
                placeholder="https://potato-stable-link.you.workers.dev" // i18n-ok: example
                value={draft.workerUrl ?? ''}
                onChange={(e) => setDraft({ ...draft, workerUrl: e.target.value })}
                className="font-mono"
              />
              <p className="mt-1 text-xs text-pm-muted">{t('tunnel.stableHelp')}</p>
            </div>
            <div>
              <FieldLabel>{t('tunnel.secret')}</FieldLabel>
              <FieldInput
                aria-label={t('tunnel.secretAria')}
                type="password"
                autoComplete="off"
                placeholder={hasStoredSecret ? t('tunnel.secretSaved') : t('tunnel.secretOwn')}
                value={draft.secret ?? ''}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                className="font-mono"
              />
              {revealed && (
                <div className="mt-2">
                  <SecretValue value={revealed} onError={setError} onHide={() => setRevealed(null)} />
                </div>
              )}
              <p className="mt-1 text-xs text-pm-muted">{t('tunnel.secretHelp')}</p>
              {mismatch && (
                <div className="mt-3 rounded-lg border border-pm-border bg-pm-bg p-3" data-testid="secret-recovery" role="group" aria-label={t('tunnel.recover.title')}>
                  <p className="text-xs font-semibold">{t('tunnel.recover.title')}</p>
                  <p className="mt-1 text-xs text-pm-muted">{t('tunnel.recover.intro')}</p>
                  <p className="mt-2 text-xs font-medium">{t('tunnel.recover.step1')}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <FieldInput
                      aria-label={t('tunnel.recover.pasteAria')}
                      data-testid="recover-secret"
                      type={pastedShown ? 'text' : 'password'}
                      autoComplete="off"
                      placeholder={t('tunnel.recover.paste')}
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value)}
                      className="min-w-0 flex-1 font-mono"
                    />
                    <button
                      type="button"
                      className={buttonClass}
                      data-testid="recover-secret-eye"
                      aria-pressed={pastedShown}
                      aria-label={pastedShown ? t('tunnel.secretEyeHide') : t('tunnel.secretEyeShow')}
                      title={pastedShown ? t('tunnel.secretEyeHide') : t('tunnel.secretEyeShow')}
                      onClick={() => setPastedShown((v) => !v)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                        <circle cx="12" cy="12" r="3" />
                        {pastedShown && <path d="M4 4l16 16" />}
                      </svg>
                    </button>
                    <button type="button" className={buttonClass} data-testid="recover-use" disabled={busy !== null || pasted.trim().length < 16} onClick={usePasted}>
                      {t('tunnel.recover.use')}
                    </button>
                  </div>
                  {pastedProblem && <p className="mt-1 text-xs text-pm-muted">{t('tunnel.problem.secret')}</p>}
                  <p className="mt-3 text-xs font-medium">{t('tunnel.recover.step2')}</p>
                  <p className="mt-1 text-xs text-pm-muted">{t('tunnel.recover.freshHelp')}</p>
                  {freshAsk ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="recover-fresh-confirm">
                      <span className="text-xs">{t('tunnel.recover.freshSure')}</span>
                      <button type="button" className={buttonClass} data-testid="recover-fresh-yes" disabled={busy !== null} onClick={startFresh}>
                        {t('tunnel.recover.freshYes')}
                      </button>
                      <button type="button" className={buttonClass} onClick={() => setFreshAsk(false)}>
                        {t('tunnel.recover.freshNo')}
                      </button>
                    </div>
                  ) : (
                    <button type="button" className={buttonClass + ' mt-2'} data-testid="recover-fresh" disabled={busy !== null} onClick={() => setFreshAsk(true)}>
                      {t('tunnel.recover.fresh')}
                    </button>
                  )}
                </div>
              )}
              {strand && (
                <div className="mt-3 rounded-lg border border-pm-border bg-pm-bg p-3" data-testid="strand-warning" role="alert">
                  <p className="text-xs font-semibold">{t('tunnel.strand.title')}</p>
                  <p className="mt-1 text-xs text-pm-muted">{strand === 'rejected' ? t('tunnel.strand.rejected') : strand === 'too_old' ? t('tunnel.strand.too_old') : strand === 'update_app' ? t('tunnel.strand.update_app') : strand === 'too_many' ? t('tunnel.strand.too_many') : t('tunnel.strand.unreachable')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {strand !== 'update_app' && strand !== 'too_many' && (
                      <button type="button" className={buttonClass} data-testid="strand-go" disabled={busy !== null} onClick={() => secretAction('regenerate', true)}>
                        {t('tunnel.strand.go')}
                      </button>
                    )}
                    <button type="button" className={buttonClass} data-testid="strand-keep" onClick={() => setStrand(null)}>
                      {t('tunnel.strand.keep')}
                    </button>
                  </div>
                </div>
              )}
              {hasStoredSecret && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {!revealed && (
                    <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => secretAction('show')}>
                      {t('tunnel.secretShow')}
                    </button>
                  )}
                  <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => secretAction('regenerate')}>
                    {t('tunnel.secretNew')}
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
          <span className={'inline-block h-2 w-2 shrink-0 rounded-full ' + DOT[line.tone]} aria-hidden />
          <span data-testid="tunnel-status" className="text-xs text-pm-muted">
            {line.text}
          </span>
          {status?.public_url && (
            <code data-testid="tunnel-url" className="break-all text-xs">
              {status.public_url}
            </code>
          )}
          {status?.stable?.quick_url && (
            <span data-testid="tunnel-quick-url" className="break-all text-xs text-pm-muted">
              {t('tunnel.stable.behind', { url: status.stable.quick_url })}
            </span>
          )}
          {status && !isStableMode(status.mode) && status.state === 'running' && (
            <span className="text-xs text-pm-muted">{t('tunnel.willChange')}</span>
          )}
        </div>

        {gaveUp && linkPending && (
          <p data-testid="tunnel-still-linking" className="text-xs text-pm-muted">
            {t('tunnel.stillLinking')}
          </p>
        )}

        {(problem && dirty) || error ? (
          <p role="alert" className="text-xs text-pm-muted">
            {error ?? problem}
          </p>
        ) : null}

        {status?.problem === 'too_soon' && (
          <div>
            <button
              type="button"
              data-testid="tunnel-try-anyway"
              className={buttonClass}
              disabled={busy !== null}
              onClick={() =>
                void run('restart', async () => {
                  setStatus(await api.restart(true));
                  setTest(null);
                })
              }
            >
              {t('tunnel.tryAnyway')}
            </button>
            <p className="mt-1 text-xs text-pm-muted">{t('tunnel.tryAnywayNote')}</p>
          </div>
        )}

        {test && (
          <p data-testid="tunnel-test" className="text-xs text-pm-muted">
            {`${test.ok ? t('tunnel.reachable') : t('tunnel.notReachable')} `}
            {test.message}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null || !dirty || problem !== null}
            onClick={() =>
              void run('save', async () => {
                const next = await api.save(toInput(draft));
                setStatus(next);
                setRevealed(next.secret_once ?? null);
                setDraft(draftFromConfig(next.config));
                setTest(null);
              })
            }
          >
            {busy === 'save' ? t('tunnel.saving') : t('tunnel.saveRestart')}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null || !status}
            onClick={() =>
              void run('restart', async () => {
                setStatus(await api.restart());
                setTest(null);
              })
            }
          >
            {busy === 'restart' ? t('tunnel.restarting') : t('tunnel.restart')}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy !== null || !status?.public_url}
            onClick={() => void run('test', async () => setTest(await api.test()))}
          >
            {busy === 'test' ? t('tunnel.testing') : t('tunnel.test')}
          </button>
        </div>
      </div>
    </section>
  );
}
