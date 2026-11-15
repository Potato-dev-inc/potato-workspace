// @vitest-environment jsdom
// The shared setup-step block: plain words for each step, and one way out of a failure (a fix button, then the raw
// output behind Details). Every self-running set-up draws this.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupStepBlock, type SetupStep } from './SetupStepBlock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const stepText = (id: string) => host.querySelector(`[data-step="${id}"]`)?.textContent ?? '';
const words = () => [...host.querySelectorAll('[data-step]')].map((li) => `${li.getAttribute('data-step')}=${li.querySelector('.ss-state')?.textContent}`);

const THREE: SetupStep[] = [
  { id: 'prepare', label: 'Getting things ready', status: 'done', tries: 1 },
  { id: 'install', label: 'Installing the tool it needs', status: 'running', tries: 2 },
  { id: 'login', label: 'Signing in to Cloudflare', status: 'waiting', tries: 0 },
];

describe('SetupStepBlock', () => {
  it('while working: each step says where it is in plain words', async () => {
    await act(async () => root.render(<SetupStepBlock steps={THREE} />));
    expect(words()).toEqual(['prepare=Done', 'install=Working…', 'login=Waiting']);
    expect(stepText('install')).toContain('Installing the tool it needs');
    // A later step says nothing about itself until its turn comes.
    expect(stepText('login')).not.toContain('browser');
  });

  it('a step being tried again counts the tries, and a step note shows only then', async () => {
    const steps: SetupStep[] = [
      { id: 'prepare', label: 'Getting things ready', status: 'done', tries: 1 },
      { id: 'login', label: 'Signing in to Cloudflare', status: 'retrying', tries: 2, note: 'Approve it in your browser.' },
    ];
    await act(async () => root.render(<SetupStepBlock steps={steps} testId="t" />));
    expect(stepText('login')).toContain('Tried 2 times. Trying again…');
    expect(q('t-note-login')!.textContent).toBe('Approve it in your browser.');
  });

  it('done: one line, and the raw output is closed under Details until asked for', async () => {
    const steps: SetupStep[] = [{ id: 'deploy', label: 'Putting it online', status: 'done', tries: 1, output: 'Uploaded 12 files.' }];
    await act(async () => root.render(<SetupStepBlock steps={steps} testId="t" done="All set." />));
    expect(q('t-done')!.textContent).toBe('All set.');
    const details = q('t-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Uploaded 12 files.');
    await act(async () => details.querySelector('summary')!.click());
    expect(details.open).toBe(true);
  });

  it('failed: plain sentence, "Let Claude fix it", Try again, and the raw error hidden until Details', async () => {
    const onFix = vi.fn();
    const onRetry = vi.fn();
    const steps: SetupStep[] = [
      { id: 'prepare', label: 'Getting things ready', status: 'done', tries: 1 },
      { id: 'install', label: 'Installing the tool it needs', status: 'failed', tries: 3, output: "EISDIR: illegal operation on a directory, lstat 'C:'" },
    ];
    await act(async () => root.render(<SetupStepBlock steps={steps} testId="t" failedId="install" onFix={onFix} onRetry={onRetry} />));
    expect(words()).toEqual(['prepare=Done', 'install=Tried 3 times']);
    const failed = q('t-failed')!;
    expect(failed.textContent).toContain('Installing the tool it needs did not work.');
    expect(failed.textContent).toContain('Tried 3 times. Nothing was left half done.');
    // The face of the failure never shows the raw text; it lives inside Details only.
    expect(failed.querySelector('[role="alert"]')!.textContent).not.toContain('EISDIR');
    const details = q('t-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector('summary')!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('EISDIR');
    expect(q('t-fix')!.textContent).toContain('Let Claude fix it');
    await act(async () => (q('t-fix') as HTMLButtonElement).click());
    expect(onFix).toHaveBeenCalledTimes(1);
    await act(async () => (q('t-retry') as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('after the hand-off it says so under the buttons', async () => {
    const steps: SetupStep[] = [{ id: 'install', label: 'Installing the tool it needs', status: 'failed', tries: 3 }];
    await act(async () =>
      root.render(<SetupStepBlock steps={steps} testId="t" failedId="install" onFix={() => {}} handed="Helper has the goal and the error." />),
    );
    expect(q('t-handed')!.textContent).toBe('Helper has the goal and the error.');
  });

  it('names the agent that gets the job: "Let Codex fix it"', async () => {
    const steps: SetupStep[] = [{ id: 'install', label: 'Installing the tool it needs', status: 'failed', tries: 3 }];
    await act(async () =>
      root.render(<SetupStepBlock steps={steps} testId="t" failedId="install" onFix={() => {}} fixAgent={{ id: 'codex', label: 'Codex' }} />),
    );
    expect(q('t-fix')!.textContent).toContain('Let Codex fix it');
  });
});
