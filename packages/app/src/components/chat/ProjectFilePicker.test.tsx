// @vitest-environment jsdom
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  findMentionQuery,
  PROJECT_FILE_DEBOUNCE_MS,
  ProjectFilePicker,
  removeMention,
  type ProjectFilePickerHandle,
} from './ProjectFilePicker';
import type { ProjectFileHit } from '../../lib/projectFiles';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HITS: ProjectFileHit[] = [
  { path: 'src/components/chat/ChatComposer.tsx', absPath: 'C:/w/src/components/chat/ChatComposer.tsx', name: 'ChatComposer.tsx', size: 120 },
  { path: 'docs/chat-notes.md', absPath: 'C:/w/docs/chat-notes.md', name: 'chat-notes.md', size: 40 },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, PROJECT_FILE_DEBOUNCE_MS + 40));
  });
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function key(name: string) {
  return { key: name, preventDefault: vi.fn() };
}

function draw(ref: RefObject<ProjectFilePickerHandle | null>, query: string, onPick = vi.fn(), onClose = vi.fn()) {
  act(() => {
    root.render(
      <ProjectFilePicker ref={ref as RefObject<ProjectFilePickerHandle>} paneId="pane-1" query={query} open anchorRect={null} onPick={onPick} onClose={onClose} />,
    );
  });
  return { onPick, onClose };
}

const options = () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
const status = () => host.querySelector('[role="status"]')?.textContent ?? '';

describe('findMentionQuery', () => {
  it('detects an @ at the start of text', () => {
    expect(findMentionQuery('@chat', 5)).toEqual({ start: 0, query: 'chat' });
  });

  it('detects an @ after whitespace', () => {
    expect(findMentionQuery('look at @Comp', 13)).toEqual({ start: 8, query: 'Comp' });
    expect(findMentionQuery('a\n@x', 4)).toEqual({ start: 2, query: 'x' });
  });

  it('gives an empty query right after the @', () => {
    expect(findMentionQuery('hi @', 4)).toEqual({ start: 3, query: '' });
  });

  it('does not treat an email-like a@b as a mention', () => {
    expect(findMentionQuery('mail a@b', 8)).toBeNull();
    expect(findMentionQuery('a@b', 3)).toBeNull();
  });

  it('returns null when whitespace sits between the @ and the caret', () => {
    expect(findMentionQuery('@chat notes', 11)).toBeNull();
    expect(findMentionQuery('no mention here', 5)).toBeNull();
  });

  it('uses the caret, not the end of the text, when the caret is in the middle', () => {
    expect(findMentionQuery('@foo bar', 3)).toEqual({ start: 0, query: 'fo' });
    expect(findMentionQuery('see @abc and more', 7)).toEqual({ start: 4, query: 'ab' });
  });
});

describe('removeMention', () => {
  it('removes the @query text up to the caret', () => {
    expect(removeMention('look at @Comp', 8, 13)).toBe('look at ');
  });

  it('keeps text after the caret', () => {
    expect(removeMention('@ch rest', 0, 3)).toBe(' rest');
  });

  it('clamps out-of-range positions', () => {
    expect(removeMention('abc', 10, 20)).toBe('abc');
  });
});

describe('ProjectFilePicker', () => {
  it('shows a loading row before the debounce, then results with the match in bold', async () => {
    vi.mocked(invoke).mockResolvedValue(HITS);
    const ref = createRef<ProjectFilePickerHandle>();
    draw(ref, 'chat');
    expect(status()).toBe('Searching…');
    await settle();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('project_files_search', expect.objectContaining({ paneId: 'pane-1', query: 'chat' }));
    const rows = options();
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('strong')?.textContent).toBe('Chat');
    expect(rows[0].querySelector('.ck-pfp-name')?.textContent).toBe('ChatComposer.tsx');
    expect(rows[0].querySelector('.ck-pfp-dir')?.textContent).toBe('src/components/chat');
    expect(rows[1].querySelector('strong')?.textContent).toBe('chat');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(rows[1].getAttribute('aria-selected')).toBe('false');
  });

  it('moves the selection with the arrow keys and picks with Enter', async () => {
    vi.mocked(invoke).mockResolvedValue(HITS);
    const ref = createRef<ProjectFilePickerHandle>();
    const { onPick } = draw(ref, 'chat');
    await settle();
    const down = key('ArrowDown');
    act(() => {
      expect(ref.current!.handleKey(down)).toBe(true);
    });
    expect(down.preventDefault).toHaveBeenCalled();
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    act(() => {
      ref.current!.handleKey(key('ArrowDown'));
    });
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    act(() => {
      ref.current!.handleKey(key('ArrowUp'));
    });
    const enter = key('Enter');
    act(() => {
      expect(ref.current!.handleKey(enter)).toBe(true);
    });
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith(HITS[1]);
  });

  it('picks on Tab and on click', async () => {
    vi.mocked(invoke).mockResolvedValue(HITS);
    const ref = createRef<ProjectFilePickerHandle>();
    const { onPick } = draw(ref, 'chat');
    await settle();
    act(() => {
      ref.current!.handleKey(key('Tab'));
    });
    expect(onPick).toHaveBeenLastCalledWith(HITS[0]);
    act(() => {
      options()[1].click();
    });
    expect(onPick).toHaveBeenLastCalledWith(HITS[1]);
  });

  it('does not consume ordinary keys', async () => {
    vi.mocked(invoke).mockResolvedValue(HITS);
    const ref = createRef<ProjectFilePickerHandle>();
    draw(ref, 'chat');
    await settle();
    act(() => {
      expect(ref.current!.handleKey(key('a'))).toBe(false);
    });
  });

  it('closes on Escape without picking', async () => {
    vi.mocked(invoke).mockResolvedValue(HITS);
    const ref = createRef<ProjectFilePickerHandle>();
    const { onPick, onClose } = draw(ref, 'chat');
    await settle();
    act(() => {
      expect(ref.current!.handleKey(key('Escape'))).toBe(true);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('ignores a stale response that arrives after a newer query', async () => {
    const resolvers: Array<(v: ProjectFileHit[]) => void> = [];
    vi.mocked(invoke).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve as (v: ProjectFileHit[]) => void)),
    );
    const ref = createRef<ProjectFilePickerHandle>();
    draw(ref, 'comp');
    await settle();
    draw(ref, 'chat-notes');
    await settle();
    expect(resolvers).toHaveLength(2);
    await act(async () => {
      resolvers[1]([HITS[1]]);
    });
    await flush();
    await act(async () => {
      resolvers[0]([HITS[0]]);
    });
    await flush();
    const rows = options();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('chat-notes.md');
    expect(host.textContent).not.toContain('ChatComposer');
  });

  it('shows the empty state when nothing matches', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const ref = createRef<ProjectFilePickerHandle>();
    draw(ref, 'zzz');
    await settle();
    expect(options()).toHaveLength(0);
    expect(status()).toBe('No matching files');
  });

  it('renders nothing when closed', () => {
    const ref = createRef<ProjectFilePickerHandle>();
    act(() => {
      root.render(<ProjectFilePicker ref={ref as RefObject<ProjectFilePickerHandle>} paneId="p" query="" open={false} onPick={vi.fn()} onClose={vi.fn()} />);
    });
    expect(host.querySelector('[data-testid="project-file-picker"]')).toBeNull();
    expect(ref.current!.handleKey(key('Enter'))).toBe(false);
  });
});
