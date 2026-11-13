// "Create team relay": a Cloudflare token in, the relay deployed into the person's own account (the Rust side does
// the upload, src-tauri/src/team/relay_deploy.rs), its address out. The token is sent once and not kept here.
import { errorSentence } from '../../../lib/sayError';
import { en } from '../../../i18n/en';
import { useT } from '../../../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tauri } from '../../../lib/tauri';
import type { CloudflareAccount, RelayDeployStep, TeamApi } from '../../../lib/team';
import { Btn, FieldInput, FieldSelect, Note } from '../settings-ui';

const errText = (err: unknown): string => (errorSentence(err));

export const CLOUDFLARE_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens';

const STEPS: { step: RelayDeployStep; label: string }[] = [
  { step: 'token', label: en['relay.step.token'] },
  { step: 'upload', label: en['relay.step.upload'] },
  { step: 'subdomain', label: en['relay.step.subdomain'] },
  { step: 'health', label: en['relay.step.health'] },
  { step: 'done', label: en['relay.step.done'] },
];

/** A link that opens in the system browser in the desktop app, and as a normal link elsewhere. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="st-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
          e.preventDefault();
          void tauri.openExternalUrl(href);
        }
      }}
    >
      {children}
    </a>
  );
}

export function RelaySheet({ api, onDone, onClose }: { api: TeamApi; onDone: (url: string) => void; onClose: () => void }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [step, setStep] = useState<RelayDeployStep | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useRef(true);

  useEffect(() => {
    // StrictMode runs mount -> cleanup -> mount in dev; the cleanup clears this flag, so set it back on every mount.
    open.current = true;
    const off = api.onRelayDeployStep((s) => open.current && setStep(s));
    return () => {
      open.current = false;
      void off.then((unlisten) => unlisten());
    };
  }, [api]);

  const deploy = async () => {
    setRunning(true);
    setError(null);
    setStep(null);
    try {
      const result = await api.deployRelay(token, accounts ? accountId : null);
      if (!open.current) return;
      if (result.status === 'pick_account') {
        setAccounts(result.accounts);
        setAccountId(result.accounts[0]?.id ?? '');
        setStep(null);
      } else {
        setToken('');
        onDone(result.url);
      }
    } catch (err) {
      if (open.current) setError(errText(err));
    } finally {
      if (open.current) setRunning(false);
    }
  };

  const at = step ? STEPS.findIndex((s) => s.step === step) : -1;
  const close = () => {
    if (!running) onClose();
  };

  return (
    <div
      className="st-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div className="st-sheet st-relay" role="dialog" aria-modal="true" aria-labelledby="st-relay-title">
        <h2 id="st-relay-title">{t('teamPage.createRelay')}</h2>
        <p>{t('relay.intro')}</p>
        <ol className="st-relay-how" aria-label={t('relay.stepsAria')}>
          <li>
            <strong>{t('relay.s1a')}</strong> <ExternalLink href={CLOUDFLARE_TOKENS_URL}>{t('relay.s1b')}</ExternalLink>{t('relay.s1c')}
          </li>
          <li>
            <strong>{t('relay.s2a')}</strong> {t('relay.s2b')}
          </li>
          <li>
            <strong>{t('relay.s3a')}</strong> {t('relay.s3b')}
          </li>
        </ol>
        <FieldInput
          autoFocus
          type="password"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          aria-label={t('relay.tokenAria')}
          placeholder={t('relay.tokenPlaceholder')}
          value={token}
          disabled={running}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && token.trim() && !running) void deploy();
          }}
        />
        {accounts && accounts.length > 1 && (
          <FieldSelect aria-label={t('relay.accountAria')} value={accountId} disabled={running} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </FieldSelect>
        )}
        {at >= 0 && (
          <>
            <p className="st-relay-now" role="status">
              {error ? t('relay.stoppedAt', { n: Math.min(at + 1, 4) }) : step === 'done' ? t('relay.step.done') : t('relay.stepOf', { n: Math.min(at + 1, 4), label: t(`relay.step.${STEPS[at].step}`) })}
            </p>
            <ol className="st-relay-steps" aria-label={t('relay.progress')}>
              {STEPS.map((s, i) => {
                const state = i < at || step === 'done' ? 'done' : i === at ? (error ? 'failed' : 'now') : 'later';
                return (
                  <li key={s.step} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                    {t(`relay.step.${s.step}`)}
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {error && <Note role="alert">{error}</Note>}
        {error && <p className="st-relay-hint">{t('relay.hint')}</p>}
        <div className="st-sheet-actions">
          <Btn disabled={running} onClick={onClose}>
            {t('lend.cancel')}
          </Btn>
          <Btn primary disabled={running || !token.trim()} onClick={() => void deploy()}>
            {running ? t('discord.working') : error ? t('relay.retry') : t('relay.create')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
