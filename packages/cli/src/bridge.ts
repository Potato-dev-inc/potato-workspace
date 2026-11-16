/**
 * One way for the config commands to talk to the running app's bridge.
 *
 * - Reaches the bridge through the loopback port file only (`readBridgePort`), never a host from a flag.
 * - Sends the local secret header and, inside an agent window, `X-Potato-Workspace-Pane`
 *   (both from `readLocalSecretHeaders`). The bridge then treats a changing call as that agent's and
 *   raises an Allow card for the person.
 * - `CONSENT_PENDING` (503): the person has not answered the card yet. Say so, wait, make the same call
 *   again. `CONSENT_DENIED`: the person said no; nothing was changed.
 */
import { readBridgePort, readLocalSecretHeaders } from '@potato-workspace/shared/bridge-port';

/** Exit codes shared by every config command. */
export const EXIT = {
  ok: 0,
  failed: 1,
  unreachable: 4,
  needsConfirmation: 5,
  refused: 6,
} as const;

/** A failure that already knows its exit code and its plain-English message. */
export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Bridge {
  get<T = unknown>(path: string): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export interface BridgeOptions {
  /** How long to wait for the person to answer an Allow card before giving up. */
  consentWaitMs: number;
  /** Where "waiting for the person" notes go (stderr in the CLI). */
  note: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_CONSENT_WAIT_MS = 300_000;
const MIN_RETRY_MS = 1;
const MAX_RETRY_MS = 15_000;
const DEFAULT_RETRY_MS = 5_000;

interface ErrorBody {
  code?: string;
  message?: string;
  error?: string;
  retry_after_ms?: number | null;
}

export function retryDelay(body: ErrorBody): number {
  const asked = typeof body.retry_after_ms === 'number' ? body.retry_after_ms : DEFAULT_RETRY_MS;
  return Math.min(Math.max(asked, MIN_RETRY_MS), MAX_RETRY_MS);
}

export function createBridge(options: BridgeOptions): Bridge {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  async function once(method: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    let host: string;
    let port: number;
    try {
      ({ host, port } = await readBridgePort());
    } catch {
      throw new CliError(EXIT.unreachable, 'Potato Workspace is not running (no bridge port file). Start the app first.');
    }
    let response: Response;
    try {
      response = await fetch(new URL(path, `http://${host}:${port}`), {
        method,
        headers: { ...(await readLocalSecretHeaders()), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CliError(EXIT.unreachable, 'Potato Workspace did not answer on its bridge. Is the app running?');
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text.slice(0, 200) };
    }
    return { status: response.status, json };
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const deadline = now() + options.consentWaitMs;
    let told = false;
    for (;;) {
      const { status, json } = await once(method, path, body);
      if (status >= 200 && status < 300) return json as T;
      const err = (json ?? {}) as ErrorBody;
      if (err.code === 'CONSENT_PENDING') {
        if (!told) {
          options.note(
            'Waiting for the person: an Allow card is open in the Potato Workspace app (Inbox). Answer it there. Nothing has changed yet.',
          );
          told = true;
        }
        if (now() >= deadline) {
          throw new CliError(
            EXIT.failed,
            'The person has not answered the Allow card yet. Nothing was changed. Run the same command again after they answer.',
          );
        }
        await sleep(retryDelay(err));
        continue;
      }
      if (err.code === 'CONSENT_DENIED') {
        throw new CliError(EXIT.refused, 'The person said no on the Allow card. Nothing was changed.');
      }
      throw new CliError(
        EXIT.failed,
        `The app refused (HTTP ${status}${err.code ? `, ${err.code}` : ''}): ${err.message ?? err.error ?? 'no detail'}`,
      );
    }
  }

  return {
    get: (path) => call('GET', path),
    patch: (path, body) => call('PATCH', path, body),
    post: (path, body) => call('POST', path, body),
  };
}
