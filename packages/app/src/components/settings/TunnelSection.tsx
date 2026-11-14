// Settings > Mobile PWA > Public address: pick how the phone reaches this computer.
import { errorSentence } from '../../lib/sayError';
import { useT } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { tauri } from '../../lib/tauri';
import type { TunnelConfigInput, TunnelConnectionTest, TunnelStatus } from '../../lib/tauri-types';
import { FieldInput, FieldLabel } from './settings-ui';
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
  restart: () => Promise<TunnelStatus>;
  test: () => Promise<TunnelConnectionTest>;
}

const defaultApi: TunnelApi = {
  getStatus: () => tauri.getTunnelStatus(),
  save: (input) => tauri.setTunnelConfig(input),
  restart: () => tauri.restartTunnel(),
  test: () => tauri.testTunnelConnection(),
};

const DOT: Record<string, string> = {
  ok: 'bg-neutral-200',
  wait: 'bg-neutral-500 animate-pulse',
  bad: 'border border-neutral-300 bg-transparent',
  idle: 'bg-neutral-600',
};

const buttonClass =
  'rounded-lg border border-pm-border px-3 py-1.5 text-xs hover:bg-pm-border/40 disabled:opacity-50';

export function TunnelSection({ api = defaultApi }: { api?: TunnelApi }) {
  const t = useT();
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [draft, setDraft] = useState<TunnelDraft>(draftFromConfig(null));
  const [busy, setBusy] = useState<'save' | 'restart' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TunnelConnectionTest | null>(null);
  // The shared secret, shown only after it was made or after "Show secret"; never kept in the draft.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  // While the tunnel is coming up, poll so "Starting…" settles by itself.
  useEffect(() => {
    if (status?.state !== 'starting') return;
    const id = window.setInterval(() => {
      api
        .getStatus()
        .then((next) => next && setStatus(next))
        .catch((e: unknown) => setError(t('tunnel.checkFailed', { reason: errorSentence(e) })));
    }, 1500);
    return () => window.clearInterval(id);
  }, [api, status?.state]);

  const run = async (kind: 'save' | 'restart' | 'test', action: () => Promise<void>) => {
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
  const secretAction = (kind: 'show' | 'regenerate') =>
    void run('save', async () => {
      if (!storedWorker) return;
      const next = await api.save({ mode: 'stable', worker_url: storedWorker, secret_action: kind });
      setStatus(next);
      setRevealed(next.secret_once ?? null);
      setCopied(false);
    });
  const copySecret = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
    } catch (e) {
      setError(errorSentence(e));
    }
  };
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
            {(Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[]).map((mode) => (
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
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code data-testid="stable-secret" className="break-all text-xs">
                    {revealed}
                  </code>
                  <button type="button" className={buttonClass} onClick={() => void copySecret()}>
                    {copied ? t('tunnel.secretCopied') : t('tunnel.secretCopy')}
                  </button>
                  <button type="button" className={buttonClass} onClick={() => setRevealed(null)}>
                    {t('tunnel.secretHide')}
                  </button>
                </div>
              )}
              <p className="mt-1 text-xs text-pm-muted">{t('tunnel.secretHelp')}</p>
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

        {(problem && dirty) || error ? (
          <p role="alert" className="text-xs text-pm-muted">
            {error ?? problem}
          </p>
        ) : null}

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
                setCopied(false);
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
