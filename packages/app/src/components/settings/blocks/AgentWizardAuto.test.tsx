// @vitest-environment jsdom
// "Finish without me" in the wizard window (SPEC 11.19): the switch on the first screen (on by default, kept), the run
// that follows the typed command with no further click, the sign-in stop with Retry, and the switch off keeping today's
// first screen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureFacts } from '../../../lib/agentWizardPrompt';
import type { CustomAiSupport } from '../../../lib/custom-ai';
import type { CaptureStatus, FinishResult, ProbeInfo, StartInfo, VerifyResult, VisibleTestResult, WizardApi } from '../../../lib/agentWizard';
import { AgentWizard } from './AgentWizard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const F = '`'.repeat(3);
const GOOD = 'schema_version = 1\n# GOOD\n[agent]\nid = "nimbus"\n[tui]\nargv = []\n';
const KEY = 'pm.agentWizard.finishWithoutMe';
const TIMINGS = { pollMs: 5, stableMs: 10, patienceMs: 100, escalateMs: 50, captureMs: 20_000 };

const start: StartInfo = {
  session: 'wz_1',
  state: 'resolved',
  command: 'nimbus',
  id_suggestion: 'nimbus',
  program: { path: 'C:\\x\\nimbus.exe', display: '~\\nimbus.exe', kind: 'native' },
  version: { ok: true, args: ['--version'], text: 'nimbus 0.4', number: '0.4' },
  native_candidates: [],
  cost_note: '',
  limits: {},
};
const probe: ProbeInfo = {
  state: 'probed',
  runs: [{ label: '--help', args: ['--help'], text: 'Usage: nimbus', exit: 0, timed_out: false, truncated: false, bytes: 10, duplicate_of: null }],
  subcommands: [],
  skipped: [],
};
const captured: CaptureFacts = {
  grid: { cols: 120, rows: 40 },
  files: [{ name: 'tui_idle', text: '| > Type a task...', variants: [] }],
  facts: { exit_method: 'slash_exit', partial: [], skipped: [], hello_written: false, startup_dialogs: [], exit_screen: null, notes: [] },
};
const STEPS: CaptureStatus['steps'] = ['start', 'ready', 'message', 'permission', 'exit'].map((id) => ({ id: id as 'start', label: id, status: 'pending' as const, note: '', frames: 0 }));
const status = (over: Partial<CaptureStatus>): CaptureStatus => ({
  state: 'running',
  captured: false,
  pane: 'p',
  step: 'ready',
  steps: STEPS,
  stable_ms: 5000,
  settled: false,
  fingerprint: 'fp',
  needs_you: null,
  screen: 'NIMBUS 0.4\nTip: approve a plan\n| > Type a task...',
  can: ['skip', 'retry', 'stuck'],
  ...over,
});
const NEED = { step: 'ready' as const, kind: 'unsure', message: 'I cannot tell.' };

const verifyOk: VerifyResult = {
  ok: true,
  state: 'verified',
  errors: [],
  text: '',
  warnings: [],
  checked: { fixtures: 5, rules: 8 },
  samples_replayed: 0,
  sha256: 'x',
  planned_visible: { program: { path: 'p', display: 'p' }, args: [], env: [], env_unset: [], cwd: '<isolated folder>', grid: { cols: 120, rows: 40 }, fingerprint: 'vis-A' },
  can_visibletest: true,
};
const visibleOk: VisibleTestResult = { ok: true, state: 'tested', checks: [], errors: [], text: '', version: null, passed: 7, total: 7 };
const finished = (approval: FinishResult['approval']): FinishResult => ({
  ok: true,
  id: 'nimbus',
  file: 'C:/data/agents/nimbus.toml',
  fixtures_dir: '',
  provenance_file: '',
  state: 'needs_approval',
  fixtures: { passed: 5, total: 5 },
  approval,
});

type Mock = WizardApi & { [K in keyof WizardApi]: ReturnType<typeof vi.fn> };

/** The Rust side as the wizard window sees it: an unsure screen first, then the rest of the capture. */
function mockApi(opts: { drafters?: Array<{ id: string; label: string }>; classifier?: string; approval?: FinishResult['approval']; signInStop?: boolean } = {}): Mock {
  let phase: 'unsure' | 'after' | 'done' = 'unsure';
  let looks = 0;
  const current = () => (phase === 'unsure' ? status({ needs_you: NEED }) : phase === 'after' ? status({ step: 'message' }) : status({ step: 'exit', settled: true, can: ['retry'] }));
  return {
    start: vi.fn(async () => start),
    probe: vi.fn(async () => probe),
    verify: vi.fn(async () => verifyOk),
    livetest: vi.fn(),
    visibletest: vi.fn(async () => visibleOk),
    testStatus: vi.fn(async () => ({ running: false })),
    capturePlan: vi.fn(async () => ({ program: { path: 'C:\\x\\nimbus.exe', display: 'x' }, args: [], cwd: '<isolated folder>', grid: { cols: 120, rows: 40 }, fingerprint: 'cap-A' })),
    captureStart: vi.fn(async () => current()),
    captureStatus: vi.fn(async () => {
      if (phase === 'after') phase = 'done';
      return current();
    }),
    captureAct: vi.fn(async () => current()),
    captureShow: vi.fn(async () => undefined),
    captureFinish: vi.fn(async () => captured),
    captureDiscard: vi.fn(async () => {
      phase = 'unsure';
    }),
    verdict: vi.fn(async (_s: string, verdict: string) => {
      if (opts.signInStop) return { decision: 'stop', verdict, stop: { code: 'WIZARD_SIGN_IN_NEEDED', message: 'Sign in to nimbus (or finish its setup), then press Retry.' } };
      phase = 'after';
      return { decision: 'pressed_ready', verdict, status: current() };
    }),
    finish: vi.fn(async () => finished(opts.approval ?? { approved: true, approved_by: 'wizard', count: 9, checks: [] })),
    cancel: vi.fn(async () => ({ ok: true })),
    ask: vi.fn(async (_s: string, _agent: string, prompt: string) => {
      if (prompt.startsWith('Below is the terminal screen')) {
        looks += 1;
        return opts.classifier ?? (opts.signInStop ? 'sign_in_or_payment' : 'ready_for_input');
      }
      return `Here.\n${F}toml\n${GOOD}${F}`;
    }),
    drafters: vi.fn(async () => opts.drafters ?? [{ id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude' }]),
    get looksTaken() {
      return looks;
    },
  } as unknown as Mock;
}

const customAi: CustomAiSupport = { load: vi.fn(async () => ({ service: { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' }, keySet: false, last4: null })), save: vi.fn(async () => undefined), ask: vi.fn() } as never;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.localStorage.removeItem(KEY);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  globalThis.localStorage.removeItem(KEY);
  await act(async () => root.unmount());
  host.remove();
});

async function render(api: WizardApi, onApprove: (d: FinishResult) => void = () => undefined) {
  await act(async () => {
    root.render(<AgentWizard api={api} customAi={customAi} onClose={() => undefined} onApprove={onApprove} autoTimings={TIMINGS} />);
  });
}

const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
const text = () => host.textContent ?? '';
const box = (id: string) => host.querySelector(`#${id}`) as HTMLInputElement | null;

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function typeCommand(value: string) {
  await act(async () => {
    const input = host.querySelector('#wizard-command') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function until(check: () => boolean, what: string, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`never reached: ${what}\n${text()}`);
}

describe('the wizard has no auto-answer switches', () => {
  it('shows neither switch and starts with the person answering', async () => {
    const api = mockApi();
    await render(api);
    expect(box('wizard-finish-without-me')).toBeNull();
    expect(box('wizard-auto-answer')).toBeNull();
    expect(text()).not.toContain('Finish without me');
    expect(text()).not.toContain('Answer setup questions for me');
    await typeCommand('nimbus');
    await click(button('Find it'));
    await until(() => text().includes('It will start exactly this'), 'the capture plan');
    expect(api.start).toHaveBeenCalledWith('nimbus', false);
    expect(api.captureStart).not.toHaveBeenCalled();
    expect(api.verdict).not.toHaveBeenCalled();
    expect(button('Start')).toBeTruthy();
  });

  it('ignores an old saved "on" for either switch', async () => {
    globalThis.localStorage.setItem(KEY, 'on');
    globalThis.localStorage.setItem('pm.agentWizard.answerSetupQuestions', 'on');
    const api = mockApi();
    await render(api);
    await typeCommand('nimbus');
    await click(button('Find it'));
    await until(() => text().includes('It will start exactly this'), 'the capture plan');
    expect(api.start).toHaveBeenCalledWith('nimbus', false);
    expect(api.start).not.toHaveBeenCalledWith('nimbus', true, true);
    expect(api.captureStart).not.toHaveBeenCalled();
    globalThis.localStorage.removeItem('pm.agentWizard.answerSetupQuestions');
  });
});
