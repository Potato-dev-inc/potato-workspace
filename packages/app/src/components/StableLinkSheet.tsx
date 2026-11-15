// A small guided sheet: keep one phone address by putting your own free Cloudflare Worker in front of the automatic one.
// It saves through the same tunnel api as Settings > Connect > Address (advanced), mode 'stable'.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { errorSentence } from '../lib/sayError';
import { tauri } from '../lib/tauri';
import { teamApi } from '../lib/team';
import type { TunnelStatus } from '../lib/tauri-types';
import { Btn, FieldInput } from './settings/settings-ui';
import { draftFromConfig, draftProblem, statusLine, toInput } from './settings/tunnel-model';
import type { TunnelApi } from './settings/TunnelSection';

export const STABLE_GUIDE_URL = 'https://github.com/Potato-dev-inc/potato-workspace/tree/main/relay/stable-link#readme';
/** The three commands, run inside the Worker folder (relay/stable-link in the Potato Workspace folder). */
const COMMANDS = ['cd relay/stable-link && npm install', 'npx wrangler login', 'npm run deploy']; // i18n-ok: shell commands

/** A team relay address saved in Settings > Team, when it is a workers.dev address. */
async function defaultRelaySuggestion(): Promise<string | null> {
  const url = (await teamApi.configGet()).relay?.trim().replace(/\/+$/, '') ?? '';
  return /^https:\/\/[^/]+\.workers\.dev$/i.test(url) ? url : null;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* no clipboard here: the text stays selectable */
  }
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <div className="stable-cmd">
      <code className="font-mono break-all">{text}</code>
      <Btn
        small
        aria-label={label}
        onClick={() => {
          void copyText(text);
          setDone(true);
        }}
      >
        {done ? t('tunnel.secretCopied') : t('settings.copy')}
      </Btn>
    </div>
  );
}

export function StableLinkSheet({
  api,
  initial,
  onStatus,
  onClose,
  relaySuggestion = defaultRelaySuggestion,
}: {
  api: TunnelApi;
  initial: TunnelStatus | null;
  onStatus: (status: TunnelStatus) => void;
  onClose: () => void;
  /** The saved team relay address, if any (a workers.dev address). Tests give their own. */
  relaySuggestion?: () => Promise<string | null>;
}) {
  const t = useT();
  const [status, setStatus] = useState<TunnelStatus | null>(initial);
  const [worker, setWorker] = useState(initial?.config.mode === 'stable' ? (initial.config.url ?? '') : '');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relay, setRelay] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.resolve()
      .then(relaySuggestion)
      .then((url) => alive && setRelay(url))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [relaySuggestion]);

  const take = useCallback(
    (next: TunnelStatus) => {
      setStatus(next);
      onStatus(next);
    },
    [onStatus],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // While linking, check again so "Not linked yet" settles by itself.
  const link = status?.mode === 'stable' ? status.stable?.link : undefined;
  useEffect(() => {
    if (link !== 'waiting' && link !== 'linking') return;
    const id = window.setInterval(() => void api.getStatus().then((n) => n && take(n)).catch(() => undefined), 2000);
    return () => window.clearInterval(id);
  }, [api, link, take]);

  const stored = status?.config.mode === 'stable' ? status.config.url : null;
  const problem = draftProblem({ ...draftFromConfig(status?.config), mode: 'stable', workerUrl: worker }, status?.config);
  const run = async (action: () => Promise<TunnelStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      take(next);
      if (next.secret_once) setSecret(next.secret_once);
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };
  const saveWorker = () =>
    run(() => api.save(toInput({ ...draftFromConfig(status?.config), mode: 'stable', workerUrl: worker })));
  const showSecret = () => run(() => api.save({ mode: 'stable', worker_url: stored ?? worker, secret_action: 'show' }));
  const linked = link === 'linked';
  const reason = status?.mode === 'stable' ? (status.stable?.error ?? statusLine(status).text) : t('stable.notYet');

  return (
    <div className="stable-overlay" role="presentation" onClick={onClose}>
      <div
        className="stable-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('stable.title')}
        data-testid="stable-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">{t('stable.title')}</h3>

        <ol className="stable-steps">
          <li>
            <strong>{t('stable.step1')}</strong>
            <p>{t('stable.what')}</p>
          </li>
          <li>
            <strong>{t('stable.step2')}</strong>
            <p>{t('stable.deployHelp')}</p>
            {COMMANDS.map((c) => (
              <CopyLine key={c} text={c} label={`${t('settings.copy')}: ${c}`} />
            ))}
            <button type="button" className="st-linkbtn" data-testid="stable-guide" onClick={() => void tauri.openExternalUrl(STABLE_GUIDE_URL)}>
              {t('stable.guide')}
            </button>
          </li>
          <li>
            <strong>{t('stable.step3')}</strong>
            <p>{t('stable.pasteHelp')}</p>
            {relay && relay !== worker.trim() && (
              <p data-testid="stable-relay-suggestion">
                <button type="button" className="st-linkbtn stable-keep" onClick={() => setWorker(relay)}>
                  {t('stable.useRelay', { url: relay })}
                </button>
                <span className="block">{t('stable.relayNote')}</span>
              </p>
            )}
            <div className="flex gap-2 items-center">
              <FieldInput
                aria-label={t('tunnel.workerAria')}
                className="font-mono"
                placeholder="https://potato-stable-link.you.workers.dev" // i18n-ok: example
                value={worker}
                onChange={(e) => setWorker(e.target.value)}
              />
              <Btn primary data-testid="stable-link" disabled={busy || problem !== null} onClick={() => void saveWorker()}>
                {busy ? t('tunnel.saving') : t('stable.link')}
              </Btn>
            </div>
          </li>
          <li>
            <strong>{t('stable.step4')}</strong>
            <p>{t('stable.secretHelp')}</p>
            {secret ? (
              <>
                <CopyLine text={secret} label={`${t('settings.copy')}: ${t('tunnel.secret')}`} />
                <Btn small onClick={() => setSecret(null)}>
                  {t('tunnel.secretHide')}
                </Btn>
              </>
            ) : (
              <Btn small data-testid="stable-show-secret" disabled={busy || !stored || !status?.config.has_secret} onClick={() => void showSecret()}>
                {t('tunnel.secretShow')}
              </Btn>
            )}
          </li>
        </ol>

        <p className="stable-status" data-testid="stable-status" data-linked={linked ? 'true' : undefined} aria-live="polite">
          {linked ? t('stable.linkedOk') : t('stable.notLinked')}{' '}
          <span className="text-pm-muted">{linked ? (status?.stable?.worker_url ?? '') : reason}</span>
        </p>
        {error && (
          <p role="alert" className="st-note">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Btn onClick={onClose}>{t('stable.close')}</Btn>
        </div>
      </div>
    </div>
  );
}
