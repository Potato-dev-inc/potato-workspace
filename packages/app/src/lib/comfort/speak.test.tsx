// @vitest-environment jsdom
// Say results out loud: the line for a finished agent, only new finishes are spoken, and only when switched on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem, AttentionSnapshot } from '../attention';
import { COMFORT_DEFAULTS } from './model';
import { finishedLine, useSpeakFinished } from './speak';
import { setComfort } from './store';

const done = (id: string, agent = 'Claude'): AttentionItem =>
  ({ id, key: `done:${id}`, kind: 'done', state: 'open', lane: 'ready', pane: { id: `p-${id}`, heading: 'Chat', agent, project: null }, title: 'Finished' }) as unknown as AttentionItem;
const snapshot = (items: AttentionItem[]): AttentionSnapshot => ({ items, counts: { blocking: 0 } }) as unknown as AttentionSnapshot;

function Watch({ snap }: { snap: AttentionSnapshot | null }) {
  useSpeakFinished(snap);
  return null;
}

describe('the spoken line', () => {
  it('says the agent finished, and nothing for any other kind of item', () => {
    expect(finishedLine(done('a'))).toBe('Claude finished.');
    expect(finishedLine(done('b', 'Codex'))).toBe('Codex finished.');
    expect(finishedLine({ ...done('c'), kind: 'approval' } as unknown as AttentionItem)).toBeNull();
  });
});

describe('when results are spoken', () => {
  let spoken: string[];
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (u: { text: string }) => spoken.push(u.text) } });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string;
        lang = '';
        constructor(text: string) {
          this.text = text;
        }
      },
    );
    setComfort({ ...COMFORT_DEFAULTS, speakResults: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    setComfort(COMFORT_DEFAULTS);
  });

  it('is silent on the first look (finishes already there), then speaks a new finish once', async () => {
    setComfort({ speakResults: true });
    await act(async () => root.render(<Watch snap={snapshot([done('old')])} />));
    expect(spoken).toEqual([]);
    await act(async () => root.render(<Watch snap={snapshot([done('old'), done('new', 'Codex')])} />));
    expect(spoken).toEqual(['Codex finished.']);
    await act(async () => root.render(<Watch snap={snapshot([done('old'), done('new', 'Codex')])} />));
    expect(spoken).toEqual(['Codex finished.']);
  });

  it('stays silent while the switch is off', async () => {
    await act(async () => root.render(<Watch snap={snapshot([done('old')])} />));
    await act(async () => root.render(<Watch snap={snapshot([done('old'), done('new')])} />));
    expect(spoken).toEqual([]);
  });
});
