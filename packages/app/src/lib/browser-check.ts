// "Check it in the browser" (R4-11): the typed command surface. The backend (src-tauri/src/commands/browser_check.rs)
// opens the app's page in the agent browser, reads the console and the network, takes a picture and answers.
import { invoke } from '@tauri-apps/api/core';
import { sayError } from './sayError';

export type CheckVerdict = 'pass' | 'fail' | 'sign_in';

/** What the backend answers. `screenshot` is a `data:image/jpeg;base64,...` address, or null. */
export interface CheckReport {
  verdict: CheckVerdict;
  pass: boolean;
  url: string;
  title: string;
  loaded: boolean;
  problem_count: number;
  /** One line each, like `error: Cannot read properties of undefined`. These words come from the web page. */
  problems: string[];
  screenshot: string | null;
}

export interface BrowserCheckApi {
  /** Whether the Labs switch "Agent browser" is on. */
  enabled: () => Promise<boolean>;
  run: (paneId: string, url: string) => Promise<CheckReport>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const browserCheckApi: BrowserCheckApi = {
  enabled: async () => (isTauri() ? invoke<boolean>('browser_check_enabled') : false),
  run: (paneId, url) => {
    if (!isTauri()) return Promise.reject(new Error('Desktop shell required: browser_check_it'));
    return invoke<CheckReport>('browser_check_it', { paneId, url });
  },
};

/** The globe button: opens the browser window for the person (an address is optional). Rejects with one sentence. */
export function openBrowserWindow(url?: string): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error('Desktop shell required: browser_open_window'));
  return invoke<void>('browser_open_window', { url: url ?? null });
}

/** The message that asks the agent to fix what the check found. The lines are copied from the page's console. */
export function fixRequest(report: CheckReport, lead: string): string {
  const lines = report.problems
    .slice(0, 10)
    .map((p) => `- ${p}`)
    .join('\n');
  return `${lead}\n${report.url}\n${lines}`.trim();
}

/** One plain sentence for a failed call. */
export function checkError(e: unknown, fallback: string): string {
  if (typeof e === 'string' && e.trim()) return e;
  return sayError(e, 'browser-check', fallback).text;
}
