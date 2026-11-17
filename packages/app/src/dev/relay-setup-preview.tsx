import { RelaySetupSheet } from '../components/connect/RelaySetup';
import type { TunnelApi } from '../components/settings/TunnelSection';
import type { TunnelStatus } from '../lib/tauri-types';
import type { StepAnswer, UpdateApi } from '../lib/workerUpdate';

// The one-button relay setup sheet in one state, with fake step commands (dev evidence only).
export type RelayPreviewMode =
  'progress' | 'done' | 'signin' | 'offline' | 'subdomain' | 'unverified' | 'install' | 'ratelimit' | 'mismatch' | 'linking' | 'other';

const WORKER = 'https://pm-relay.maya.workers.dev';
const stable = (link: 'linked' | 'waiting' | 'failed', mismatch = false): TunnelStatus =>
  ({
    mode: 'stable',
    public_url: null,
    state: 'running',
    error: null,
    config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
    stable: { worker_url: WORKER, quick_url: null, link, error: mismatch ? 'The secret does not match.' : null, secret_mismatch: mismatch },
  }) as TunnelStatus;

const FAIL: Partial<Record<RelayPreviewMode, [string, string]>> = {
  signin: ['login', 'Login was cancelled by the user.'],
  offline: ['deploy', 'getaddrinfo ENOTFOUND api.cloudflare.com'],
  subdomain: ['deploy', 'You need to register a workers.dev subdomain before deploying.'],
  unverified: ['deploy', 'Please verify your email address to deploy.'],
  install: ['install', 'npm ERR! network request failed'],
  ratelimit: ['deploy', 'Error 429: too many requests'],
  other: ['deploy', 'Unexpected error while uploading the script.'],
};

export function Preview({ mode }: { mode: RelayPreviewMode }) {
  const fail = FAIL[mode];
  const updateApi: UpdateApi = {
    pauseMs: 0,
    check: async () => ({ reachable: true, features: ['team', 'stable-link'], legacyLink: false }),
    step: async (id): Promise<StepAnswer> => {
      if (mode === 'progress' && id === 'login') return new Promise<StepAnswer>(() => undefined);
      if (fail && fail[0] === id) return { ok: false, output: fail[1] };
      return { ok: true, output: `${id} ok`, url: id === 'deploy' ? WORKER : undefined };
    },
  };
  const after = mode === 'mismatch' ? stable('failed', true) : mode === 'linking' ? stable('waiting') : stable('linked');
  const api: TunnelApi = {
    getStatus: async () => after,
    save: async () => ({ ...after, secret_once: 'KEY-0123456789-ABCDEFGHIJ' }),
    restart: async () => after,
    test: async () => ({ ok: true, url: WORKER, http_status: 200, latency_ms: 1, message: 'ok' }),
  };
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999 }}>
      <RelaySetupSheet api={api} updateApi={updateApi} onClose={() => undefined} />
    </div>
  );
}
