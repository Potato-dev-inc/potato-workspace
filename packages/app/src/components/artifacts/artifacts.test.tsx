// @vitest-environment jsdom
// Artifacts (N5-20): the locked frame is pinned (sandbox attribute and content policy), the card is wired into the chat
// screen (and costs a turn nothing: no new objects per render), the tab shows versions and a newer one, and the phone's
// full-screen view asks the PC and shows what a locked agent answers.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { ARTIFACT_NOTICE, framePage, MERMAID_SRC, parseArtifactRef, type Artifact, type ArtifactPage, type ArtifactsApi } from '../../lib/artifacts';
import { artifactTabPath, openArtifactTab, artifactTabTitle } from '../../lib/artifact-tabs';
import { resetFileTabs, usePaneFiles } from '../../lib/file-tabs';
import type { BridgeClient, PhoneArtifact } from '../../lib/bridge-types';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { CDN_HOSTS, sandboxAttribute, sandboxDocument, sandboxPolicy } from '../files/SandboxFrame';
import { SessionChatView, turnRenders } from '../chat/SessionChatView';
import { PhoneArtifactScreen } from '../mobile/PhoneArtifact';
import { PhoneConversation } from '../mobile/PhoneConversation';
import { ArtifactBody } from './ArtifactBody';
import { ArtifactTab } from './ArtifactTab';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  resetFileTabs();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const flush = () => act(async () => void (await Promise.resolve()));

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'plan',
    title: 'Launch plan',
    kind: 'html',
    createdAt: 't',
    updatedAt: 't',
    versions: [
      { n: 1, at: 't', bytes: 10 },
      { n: 2, at: 't', bytes: 12 },
    ],
    ...over,
  };
}

function fakeApi(over: Partial<ArtifactsApi> = {}) {
  const read = vi.fn(async (_p: string, _id: string, version?: number): Promise<ArtifactPage> => {
    const v = version ?? 2;
    return { artifact: artifact(), version: v, content: `<h1>version ${v}</h1>`, path: 'C:/proj/.potato/artifacts/plan/v' + v + '.html' };
  });
  const api: ArtifactsApi = { sync: vi.fn(async () => [artifact()]), read, openInBrowser: vi.fn(async () => undefined), ...over };
  return { api, read };
}

describe('the locked frame (pinned)', () => {
  it('only ever allows scripts: never the app, its storage, top navigation, popups, forms or downloads', () => {
    expect(sandboxAttribute({ allowScripts: true, cdn: true })).toBe('allow-scripts');
    expect(sandboxAttribute()).toBe('');
    for (const word of ['allow-same-origin', 'allow-top-navigation', 'allow-popups', 'allow-forms', 'allow-modals', 'allow-downloads', 'allow-pointer-lock']) {
      expect(sandboxAttribute({ allowScripts: true, cdn: true })).not.toContain(word);
    }
  });

  it('the content policy fetches nothing but pictures written into the page and the three script libraries', () => {
    const policy = sandboxPolicy({ allowScripts: true, cdn: true });
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toContain('connect-src');
    expect(policy).not.toMatch(/\*|http:|ws:|wss:|frame-src|object-src/);
    expect(CDN_HOSTS).toEqual(['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com']);
    const hosts = policy.match(/https:\/\/[a-z.]+/g) ?? [];
    expect(new Set(hosts)).toEqual(new Set(CDN_HOSTS));
    // The pictures stay local, even with the libraries.
    expect(policy).toContain('img-src data: blob:');
    // Without `cdn` there is no host at all.
    expect(sandboxPolicy({ allowScripts: true })).not.toContain('https:');
    expect(sandboxPolicy()).not.toContain('script-src');
  });

  it('the policy is the first thing in the page, after a doctype only', () => {
    const doc = sandboxDocument('<!DOCTYPE html><script>1</script>', { allowScripts: true, cdn: true });
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<script>'));
    expect(sandboxDocument('<p>x</p>', { allowScripts: true }).startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('an artifact frame is srcdoc only: no address to load, and no Tauri bridge reaches into it', () => {
    act(() => root.render(<ArtifactBody kind="html" content="<p>hi</p>" title="Hi" />));
    const frame = host.querySelector<HTMLIFrameElement>('iframe[data-testid="sandbox-frame"]')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    // Opaque origin: the frame cannot read this window's Tauri internals (they are not reachable from a sandboxed document).
    expect(frame.getAttribute('sandbox')).not.toContain('same-origin');
  });

  it('a picture (SVG) never gets scripts, a diagram loads one pinned library from one allowed host', () => {
    const svg = framePage('svg', '<svg onload="alert(1)"></svg>');
    expect([svg.allowScripts, svg.cdn]).toEqual([false, false]);
    expect(sandboxPolicy({ allowScripts: svg.allowScripts, cdn: svg.cdn })).not.toContain('script-src');
    const mermaid = framePage('mermaid', 'graph TD\n A-->B <script>');
    expect([mermaid.allowScripts, mermaid.cdn]).toEqual([true, true]);
    expect(MERMAID_SRC).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\//);
    expect(CDN_HOSTS.some((h) => MERMAID_SRC.startsWith(h))).toBe(true);
    // The diagram text is data: it cannot close the tag around it.
    expect(mermaid.html).toContain('A--&gt;B &lt;script&gt;');
  });
});

describe('the card address', () => {
  it('reads what the PC writes and nothing else', () => {
    expect(parseArtifactRef('potato-artifact:plan/2/html')).toEqual({ id: 'plan', version: 2, kind: 'html' });
    for (const bad of [undefined, null, '', 'https://x', 'potato-artifact:../x/1/html', 'potato-artifact:a/0/html', 'potato-artifact:a/1/pdf', 'potato-artifact:A/1/html']) {
      expect(parseArtifactRef(bad as string)).toBeNull();
    }
  });
});

function items(withCard: boolean): ChatItem[] {
  return [
    { kind: 'user', id: 'u1', at: null, text: 'Make me a plan page' },
    { kind: 'assistant', id: 'a1', at: null, text: 'Here it is.', model: null, finalAnswer: true },
    ...(withCard ? ([{ kind: 'notice', id: 'artifact:plan:v1', at: null, noticeKind: ARTIFACT_NOTICE, text: 'Launch plan', url: 'potato-artifact:plan/1/html' }] as ChatItem[]) : []),
    { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 1000 },
  ];
}

describe('the card in the chat screen', () => {
  function Chat({ list, mode }: { list: ChatItem[]; mode?: 'summary' }) {
    if (mode) localStorage.setItem('pm.chat-view-mode.p-art', mode);
    return <SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(list).turns} model={null} cliVersion={null} paneId="p-art" />;
  }
  function Tabs() {
    const files = usePaneFiles('p-art');
    return <ul data-testid="tabs">{files.files.map((f) => <li key={f}>{f}</li>)}</ul>;
  }

  it('a page notice is a card with its title, kind and version, and Open puts a tab beside the chat', () => {
    act(() =>
      root.render(
        <>
          <Chat list={items(true)} />
          <Tabs />
        </>,
      ),
    );
    const card = host.querySelector<HTMLElement>('[data-testid="artifact-card"]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Launch plan');
    expect(card.textContent).toContain('Web page · version 1');
    expect(host.querySelector('[data-notice="artifact"]')).toBeNull();
    act(() => void card.querySelector('button')!.click());
    expect([...host.querySelectorAll('[data-testid="tabs"] li')].map((n) => n.textContent)).toEqual([artifactTabPath('plan')]);
    expect(artifactTabTitle(artifactTabPath('plan'))).toBe('Launch plan');
  });

  it('a card whose address cannot be read is the plain line, never a broken card', () => {
    const list = items(true).map((i) => (i.kind === 'notice' ? { ...i, url: 'garbage' } : i));
    act(() => root.render(<Chat list={list} />));
    expect(host.querySelector('[data-testid="artifact-card"]')).toBeNull();
    expect(host.querySelector('[data-notice="artifact"]')?.textContent).toContain('Launch plan');
  });

  it('a settled turn is not drawn again when the chat is drawn again with the same turns (the memo holds with a card in it)', () => {
    const turns = groupTurns(items(true)).turns;
    const view = (tick: number) => (
      <>
        <span data-tick={tick} />
        <SessionChatView state="ready" reason={null} source="acp" turns={turns} model={null} cliVersion={null} paneId="p-art" />
      </>
    );
    act(() => root.render(view(1)));
    const before = turnRenders.count;
    act(() => root.render(view(2)));
    act(() => root.render(view(3)));
    expect(turnRenders.count).toBe(before);
    expect(host.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(1);
  });
});

describe('the tab beside the chat', () => {
  it('shows the newest version, lists the versions, and a picked version is read', async () => {
    const { api, read } = fakeApi();
    act(() => root.render(<ArtifactTab paneId="p1" id="plan" api={api} pollMs={0} />));
    await flush();
    expect(read).toHaveBeenCalledWith('p1', 'plan', undefined);
    const frame = host.querySelector<HTMLIFrameElement>('iframe')!;
    expect(frame.getAttribute('srcdoc')).toContain('version 2');
    const picker = host.querySelector<HTMLSelectElement>('select')!;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Version 2 (newest)', 'Version 1']);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(picker, '1');
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(read).toHaveBeenLastCalledWith('p1', 'plan', 1);
    expect(host.querySelector('iframe')!.getAttribute('srcdoc')).toContain('version 1');
  });

  it('Open in browser and Copy file path act on the version on screen; a Markdown page has no browser button', async () => {
    const { api } = fakeApi();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() => root.render(<ArtifactTab paneId="p1" id="plan" api={api} pollMs={0} />));
    await flush();
    const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => void button('Open in browser').click());
    expect(api.openInBrowser).toHaveBeenCalledWith('p1', 'plan', 2);
    await act(async () => void button('Copy file path').click());
    expect(writeText).toHaveBeenCalledWith('C:/proj/.potato/artifacts/plan/v2.html');
    // A Markdown page: no browser button.
    const md = fakeApi({ read: vi.fn(async () => ({ artifact: artifact({ kind: 'markdown' }), version: 2, content: '# Hi', path: 'p' })) });
    act(() => root.render(<ArtifactTab paneId="p1" id="plan" api={md.api} pollMs={0} />));
    await flush();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Open in browser')).toBe(false);
    expect(host.querySelector('[data-testid="artifact-markdown"]')?.textContent).toContain('Hi');
  });

  it('says so when the agent makes a newer version, and Show it loads that one', async () => {
    vi.useFakeTimers();
    let newest = 2;
    const { api, read } = fakeApi({
      sync: vi.fn(async () => [artifact({ versions: Array.from({ length: newest }, (_, i) => ({ n: i + 1, at: 't', bytes: 1 })) })]),
    });
    act(() => root.render(<ArtifactTab paneId="p1" id="plan" api={api} pollMs={1000} />));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(host.querySelector('[data-testid="artifact-newer"]')).toBeNull();
    newest = 3;
    await act(async () => void (await vi.advanceTimersByTimeAsync(1100)));
    expect(host.querySelector('[data-testid="artifact-newer"]')).not.toBeNull();
    read.mockClear();
    const show = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show it')!;
    await act(async () => void show.click());
    expect(read).toHaveBeenCalledWith('p1', 'plan', undefined);
  });
});

describe('the card on the phone', () => {
  it('is wired into the phone conversation: a tap hands the page to the opener; without an opener it is a plain line', () => {
    const open = vi.fn();
    const turns = groupTurns(items(true)).turns;
    act(() => root.render(<PhoneConversation state="ready" reason={null} source="acp" turns={turns} onOpenArtifact={open} />));
    const card = host.querySelector<HTMLElement>('[data-testid="artifact-card"]')!;
    expect(card.textContent).toContain('Launch plan');
    act(() => void card.querySelector('button')!.click());
    expect(open).toHaveBeenCalledWith({ id: 'plan', version: 1, kind: 'html' }, 'Launch plan');
    act(() => root.render(<PhoneConversation state="ready" reason={null} source="acp" turns={turns} />));
    expect(host.querySelector('[data-testid="artifact-card"]')).toBeNull();
    expect(host.querySelector('[data-notice="artifact"]')?.textContent).toContain('Launch plan');
  });
});

describe('the phone page', () => {
  const phonePage: PhoneArtifact = { id: 'plan', title: 'Launch plan', kind: 'html', latest: 1, version: 1, versions: [{ n: 1, at: 't', bytes: 5 }], updatedAt: 't', content: '<p>phone page</p>' };

  it('asks the PC for the version on the card and shows it in the locked frame', async () => {
    const paneArtifact = vi.fn(async () => phonePage);
    const bridge = { paneArtifact } as unknown as BridgeClient;
    act(() => root.render(<PhoneArtifactScreen bridge={bridge} paneId="p1" id="plan" version={1} title="Launch plan" onClose={() => undefined} />));
    await flush();
    expect(paneArtifact).toHaveBeenCalledWith('p1', 'plan', 1);
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="phone-artifact"] iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('phone page');
  });

  it('shows the PC\'s sentence, not a page, when the agent is locked for phones', async () => {
    const paneArtifact = vi.fn(async () => {
      throw new Error('Remote control is off for this agent. Switch it on in the agent\'s Remote control card on your PC.');
    });
    act(() => root.render(<PhoneArtifactScreen bridge={{ paneArtifact } as unknown as BridgeClient} paneId="p1" id="plan" version={1} title="Launch plan" onClose={() => undefined} />));
    await flush();
    expect(document.querySelector('[data-testid="phone-artifact"] iframe')).toBeNull();
    expect(document.querySelector('[data-testid="phone-artifact"] [role="alert"]')?.textContent).toContain('Remote control is off');
  });

  it('a page too big for the phone says so instead of drawing it', async () => {
    const bridge = { paneArtifact: vi.fn(async () => ({ ...phonePage, content: undefined, tooLarge: true })) } as unknown as BridgeClient;
    act(() => root.render(<PhoneArtifactScreen bridge={bridge} paneId="p1" id="plan" version={1} title="Launch plan" onClose={() => undefined} />));
    await flush();
    expect(document.querySelector('[data-testid="phone-artifact"]')?.textContent).toContain('too big for the phone');
    expect(document.querySelector('[data-testid="phone-artifact"] iframe')).toBeNull();
  });
});

describe('opening twice', () => {
  it('one tab per page', () => {
    openArtifactTab('p9', 'plan', 'Launch plan');
    openArtifactTab('p9', 'plan', 'Launch plan (new title)');
    function Tabs() {
      return <p data-testid="n">{usePaneFiles('p9').files.length}</p>;
    }
    act(() => root.render(<Tabs />));
    expect(host.querySelector('[data-testid="n"]')?.textContent).toBe('1');
    expect(artifactTabTitle(artifactTabPath('plan'))).toBe('Launch plan (new title)');
  });
});
