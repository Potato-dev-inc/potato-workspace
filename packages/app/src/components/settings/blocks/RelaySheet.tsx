// "Create team relay": a Cloudflare token in, the relay deployed into the person's own account (the Rust side does
// the upload, src-tauri/src/team/relay_deploy.rs), its address out. The token is sent once and not kept here.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tauri } from '../../../lib/tauri';
import type { CloudflareAccount, RelayDeployStep, TeamApi } from '../../../lib/team';
import { Btn, FieldInput, FieldSelect, Note } from '../settings-ui';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const CLOUDFLARE_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens';

const STEPS: { step: RelayDeployStep; label: string }[] = [
  { step: 'token', label: 'Checking token' },
  { step: 'upload', label: 'Uploading relay' },
  { step: 'subdomain', label: 'Turning on workers.dev' },
  { step: 'health', label: 'Waiting for relay' },
  { step: 'done', label: 'Done' },
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
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<CloudflareAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [step, setStep] = useState<RelayDeployStep | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useRef(true);

  useEffect(() => {
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
        <h2 id="st-relay-title">Create team relay</h2>
        <p>The relay runs in your own Cloudflare account, on the free plan. It only passes on encrypted messages.</p>
        <p>
          <ExternalLink href={CLOUDFLARE_TOKENS_URL}>Create a Cloudflare token</ExternalLink>. Use the “Edit Cloudflare Workers” template.
        </p>
        <FieldInput
          autoFocus
          type="password"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          aria-label="Cloudflare token"
          placeholder="Paste the token"
          value={token}
          disabled={running}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && token.trim() && !running) void deploy();
          }}
        />
        {accounts && accounts.length > 1 && (
          <FieldSelect aria-label="Cloudflare account" value={accountId} disabled={running} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </FieldSelect>
        )}
        {at >= 0 && (
          <ol className="st-relay-steps" aria-label="Progress">
            {STEPS.map((s, i) => {
              const state = i < at || step === 'done' ? 'done' : i === at ? (error ? 'failed' : 'now') : 'later';
              return (
                <li key={s.step} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                  {s.label}
                </li>
              );
            })}
          </ol>
        )}
        {error && <Note role="alert">{error}</Note>}
        <div className="st-sheet-actions">
          <Btn disabled={running} onClick={onClose}>
            Cancel
          </Btn>
          <Btn primary disabled={running || !token.trim()} onClick={() => void deploy()}>
            {running ? 'Deploying…' : error ? 'Retry' : 'Deploy'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
