// @vitest-environment jsdom
// The sidebar row: the Potato face for the mood, the name and the live line; the needs-you tint; the quiet "Make" line;
// the still picture for people who prefer reduced motion.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionView } from '../../../lib/companion';
import type { Mood } from '../../../lib/companionMood';
import { setLanguagePref } from '../../../i18n';
import { CompanionRow, MakeCompanionRow } from './CompanionRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLanguagePref('en', false);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguagePref('auto', false);
});

const view = (over: Partial<CompanionView> = {}): CompanionView => ({
  id: 'mochi',
  name: 'Mochi',
  avatar: 'mochi',
  persona: 'calm',
  agentType: 'claude',
  agentLabel: 'Claude',
  folderName: 'companion-test',
  state: 'idle',
  stateLine: 'Here. Ask me anything.',
  paneId: 'companion-mochi',
  needs: null,
  pendingMemory: 0,
  nextCheckin: null,
  restarts: 0,
  autoStart: true,
  ...over,
});
const calm: Mood = { face: 'idle', key: 'companion.mood.watching', vars: { count: 3 }, urgent: false };

describe('CompanionRow', () => {
  it('shows the Potato face, the name and the live line', () => {
    act(() => root.render(<CompanionRow companion={view()} mood={calm} active={false} onOpen={() => {}} />));
    expect(host.querySelector('img[data-potato-state="idle"]')).not.toBeNull();
    expect(host.querySelector('.ck-row-title')?.textContent).toBe('Mochi');
    expect(host.querySelector('.ck-companion-line')?.textContent).toBe('Watching 3 agents');
  });

  it('keeps the picture out of the screen reader and offers a still frame for reduced motion', () => {
    act(() => root.render(<CompanionRow companion={view()} mood={calm} active={false} onOpen={() => {}} />));
    expect(host.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
    const source = host.querySelector('picture > source');
    expect(source?.getAttribute('media')).toBe('(prefers-reduced-motion: reduce)');
    expect(source?.getAttribute('srcset')).not.toBe(host.querySelector('img')?.getAttribute('src'));
  });

  it('tints the row when the person is needed, with no count of its own', () => {
    const mood: Mood = { face: 'needs-you', key: 'companion.mood.oneNeedsYou', vars: { name: 'Codex' }, urgent: true };
    act(() => root.render(<CompanionRow companion={view()} mood={mood} active={false} onOpen={() => {}} />));
    expect(host.querySelector('.ck-companion-row')!.classList.contains('is-needs')).toBe(true);
    expect(host.querySelector('.ck-companion-line')?.textContent).toBe('Codex needs you');
    expect(host.querySelector('.ck-count')).toBeNull();
  });

  it('opens the companion when clicked and marks the open one', () => {
    const onOpen = vi.fn();
    act(() => root.render(<CompanionRow companion={view()} mood={calm} active onOpen={onOpen} />));
    const row = host.querySelector<HTMLButtonElement>('button')!;
    expect(row.getAttribute('aria-current')).toBe('true');
    act(() => row.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('speaks Taiwan Chinese in zh-TW', () => {
    setLanguagePref('zh-TW', false);
    act(() => root.render(<CompanionRow companion={view()} mood={calm} active={false} onOpen={() => {}} />));
    expect(host.querySelector('.ck-companion-line')?.textContent).toBe('正在看著 3 位 AI 助理');
  });
});

describe('MakeCompanionRow', () => {
  it('is one quiet line, and calls back on click', () => {
    const onMake = vi.fn();
    act(() => root.render(<MakeCompanionRow onMake={onMake} />));
    expect(host.textContent).toBe('Want a companion? Make one');
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(onMake).toHaveBeenCalledTimes(1);
  });
});
