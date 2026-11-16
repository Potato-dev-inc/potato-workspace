// @vitest-environment jsdom
// The phone bugs the founder saw (1.0.29): a giant black triangle in a chat (an icon with no size on the phone), an artifact that
// left a blank band on the right, helper chats not nested in the drawer, a new chat with no model pill, and terminal-only
// agents drawn like normal ones. Each has a screen-level check here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneRenderArtifact, phoneRenderReply } from '../../dev/phone-render-fixture';
import { PHONE_PANES } from '../../dev/phone-fixtures';
import type { BridgeClient, PhoneNewChatOptions } from '../../lib/bridge-types';
import type { PaneInfo } from '../../lib/tauri-types';
import { PhoneArtifactScreen } from './PhoneArtifact';
import { PhoneChatView } from './PhoneChatView';
import { PhoneDrawer } from './PhoneDrawer';
import { PhoneNewChat } from './PhoneNewChat';
import { nestHelpers } from './phoneNav';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  host.className = 'ph';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const flush = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe('no icon on the phone can draw giant', () => {
  it('every svg in a phone chat with a permission line, page cards and folded steps has its own size (14 to 48 px)', async () => {
    const bridge = {
      paneChat: vi.fn(async () => phoneRenderReply(Date.now())),
      paneArtifact: vi.fn(async () => phoneRenderArtifact('overview')),
    } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType />);
    });
    await flush(50);
    expect(host.querySelector('[data-testid="permission-trace"]')?.textContent).toContain('Allowed');
    expect(host.textContent).toContain('Overview page');
    // The conversation is made of pieces shared with the PC (their CSS is written for `.cockpit`); the box and header are the phone's own.
    const svgs = Array.from(host.querySelectorAll('.ph-conv svg')).filter((svg) => !svg.closest('[data-testid="phone-composer"], [data-testid="phone-rule-line"]'));
    expect(svgs.length).toBeGreaterThan(2);
    const unsized = svgs.filter((svg) => {
      const w = Number(svg.getAttribute('width'));
      const h = Number(svg.getAttribute('height'));
      // A class alone is not enough: the phone has no `.cockpit` parent, so a size that lives in cockpit-only CSS never applies.
      return !(w >= 8 && w <= 48 && h >= 8 && h <= 48);
    });
    expect(unsized.map((svg) => svg.outerHTML.slice(0, 90))).toEqual([]);
  });
});

describe('the box and the result bar carry their own icon size too (the remote chat on a PC has no phone shell around it)', () => {
  it('every svg in the whole chat view, composer included, has width and height attributes', async () => {
    const bridge = { paneChat: vi.fn(async () => phoneRenderReply(Date.now())), paneArtifact: vi.fn(async () => phoneRenderArtifact('overview')) } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType />);
    });
    await flush(50);
    const svgs = Array.from(host.querySelectorAll('svg'));
    expect(svgs.length).toBeGreaterThan(5);
    const unsized = svgs.filter((svg) => !(Number(svg.getAttribute('width')) >= 8 && Number(svg.getAttribute('height')) >= 8));
    expect(unsized.map((svg) => svg.outerHTML.slice(0, 90))).toEqual([]);
  });
});

describe('an opened page fills the phone and shrinks a fixed-width page to fit', () => {
  const open = async (id: string, wanted: number) => {
    // jsdom has no layout: the box says it is 390 px wide.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private cb: () => void) {}
        observe() {
          this.cb();
        }
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
    const bridge = { paneArtifact: vi.fn(async () => phoneRenderArtifact(id)) } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneArtifactScreen bridge={bridge} paneId="p1" id={id} version={1} title="Page" onClose={() => undefined} />);
    });
    await flush(20);
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    // The page inside tells the app how wide it wants to be.
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { t: 'potato-fit-width', w: wanted }, source: frame.contentWindow }));
    });
    return { frame, fit: document.querySelector('[data-testid="sandbox-fit"]') as HTMLElement };
  };

  it('a page as wide as the phone is not scaled and takes the whole width', async () => {
    const { frame, fit } = await open('overview', 390);
    expect(fit.dataset.scale).toBe('1.000');
    expect(frame.style.width).toBe('100%');
    expect(frame.getAttribute('srcdoc')).toContain('potato-fit-width');
  });

  it('a 1000 px page is scaled to the phone width (no blank band, no cut-off)', async () => {
    const { frame, fit } = await open('fixed', 1000);
    expect(Number(fit.dataset.scale)).toBeCloseTo(0.39, 2);
    expect(parseFloat(frame.style.width) * Number(fit.dataset.scale)).toBeCloseTo(390, 0);
    expect(frame.style.transform).toContain('scale(0.39');
  });

  it('a message from anything but the page itself is ignored', async () => {
    const { fit } = await open('overview', 390);
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { t: 'potato-fit-width', w: 5000 }, source: window }));
    });
    expect(fit.dataset.scale).toBe('1.000');
  });
});

describe('helper chats in the drawer', () => {
  const pane = (id: string, parent?: string | null): PaneInfo => ({ ...(PHONE_PANES[2] as PaneInfo), id, title: id, parent_pane_id: parent });

  it('nestHelpers puts a helper right under its parent, one step in, and leaves a lost or looping parent alone', () => {
    const list = [pane('a'), pane('b'), pane('h1', 'a'), pane('h2', 'h1'), pane('lost', 'gone'), pane('x', 'y'), pane('y', 'x')];
    expect(nestHelpers(list).map((r) => `${r.pane.id}:${r.depth}`)).toEqual(['a:0', 'h1:1', 'h2:1', 'b:0', 'lost:0', 'x:0', 'y:0']);
  });

  it('the drawer shows a helper indented under its parent with the words "Started agent"', async () => {
    const panes = [pane('a'), pane('h1', 'a')];
    await act(async () => {
      root.render(
        <PhoneDrawer open onClose={() => undefined} panes={panes} labels={new Map(panes.map((p) => [p.id, p.title ?? p.id]))} agentName={(id) => id} attention={null} active="" bridgeReady onSelect={() => undefined} onSearch={() => undefined} onSettings={() => undefined} />,
      );
    });
    const rows = Array.from(document.querySelectorAll('[data-testid="drawer-project"] > li'));
    expect(rows.map((li) => li.querySelector('.ph-drow-title')?.textContent)).toEqual(['a', 'h1']);
    expect(rows[0].getAttribute('data-testid')).toBeNull();
    expect(rows[1].getAttribute('data-testid')).toBe('drawer-helper');
    expect(rows[1].classList.contains('ph-dhelper')).toBe(true);
    expect(rows[1].textContent).toContain('Started agent');
    expect(rows[0].textContent).not.toContain('Started agent');
  });
});

describe('new chat: the model pill and the terminal-only agents', () => {
  const options: PhoneNewChatOptions = {
    agents: [
      { id: 'claude', label: 'Claude', chat: true, terminal: false },
      { id: 'agy', label: 'Agy', chat: false, terminal: true },
    ],
    projects: [{ id: 'p1', name: 'shop', state: 'repo' }],
    terminals: false,
    need_terminals: 1,
  };
  const models = { terminal: true, default_model: 'sonnet', models: ['sonnet', 'opus'], live: { id: 'model', options: [{ value: 'opus', name: 'Opus 4.7', description: 'Careful.' }, { value: 'sonnet', name: 'Sonnet 5.5', description: 'Fast.' }] }, live_failed: false };

  async function mount(modelOptions: BridgeClient['phoneModelOptions']) {
    const phoneStartChat = vi.fn(async () => ({ pane_id: 'c1', agent: 'claude', lane: 'chat' }));
    const sendPaneMessage = vi.fn(async () => ({}));
    const acpSetConfig = vi.fn(async () => ({}));
    const bridge = { phoneNewChat: async () => options, phoneStartChat, sendPaneMessage, acpSetConfig, phoneModelOptions: modelOptions } as unknown as BridgeClient;
    const onStarted = vi.fn();
    await act(async () => {
      root.render(<PhoneNewChat bridge={bridge} canControl onClose={() => undefined} onStarted={onStarted} />);
    });
    await flush(10);
    return { phoneStartChat, sendPaneMessage, acpSetConfig, onStarted };
  }

  it('shows "Loading models…" first, then the pill with the default model by its name', async () => {
    let release: (v: unknown) => void = () => undefined;
    await mount(() => new Promise((r) => (release = r)));
    expect(host.querySelector('[data-testid="nc-model-loading"]')?.textContent).toBe('Loading models…');
    await act(async () => release(models));
    await flush(10);
    expect(host.querySelector('[data-testid="nc-model-loading"]')).toBeNull();
    expect(host.querySelector('[data-testid="nc-model-pill"]')?.textContent).toBe('Sonnet 5.5');
  });

  it('a pick is set on the new chat before the first message goes', async () => {
    const { acpSetConfig, sendPaneMessage, onStarted } = await mount(async () => models);
    await act(async () => (host.querySelector('[data-testid="nc-model-pill"]') as HTMLElement).click());
    const opus = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="nc-model-sheet"] [role="radio"]')).find((r) => r.textContent?.includes('Opus 4.7'))!;
    await act(async () => opus.click());
    expect(host.querySelector('[data-testid="nc-model-pill"]')?.textContent).toBe('Opus 4.7');
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'hello');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (host.querySelector('button[type="submit"]') as HTMLElement).click());
    await flush(10);
    expect(acpSetConfig).toHaveBeenCalledWith('c1', 'model', 'opus');
    expect(sendPaneMessage).toHaveBeenCalledWith('c1', 'hello');
    expect(acpSetConfig.mock.invocationCallOrder[0]).toBeLessThan(sendPaneMessage.mock.invocationCallOrder[0]);
    expect(onStarted).toHaveBeenCalledWith('c1', 'chat', true);
  });

  it('shows no pill when the PC has no list (an older PC, or the route fails)', async () => {
    await mount(undefined);
    expect(host.querySelector('[data-testid="nc-model-pill"]')).toBeNull();
    expect(host.querySelector('[data-testid="nc-model-loading"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(async () => {
      throw new Error('404');
    });
    expect(host.querySelector('[data-testid="nc-model-pill"]')).toBeNull();
  });

  it('dims an agent that needs a terminal, tags it, and cannot pick it', async () => {
    await mount(async () => models);
    const tiles = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="nc-agent-tile"]'));
    const agy = tiles.find((t) => t.textContent?.includes('Agy'))!;
    expect(agy.hasAttribute('data-needs-terminal')).toBe(true);
    expect(agy.getAttribute('aria-disabled')).toBe('true');
    expect(agy.textContent).toContain('needs terminal');
    await act(async () => agy.click());
    expect(agy.getAttribute('aria-checked')).toBe('false');
    expect(tiles.find((t) => t.textContent?.includes('Claude'))!.hasAttribute('data-needs-terminal')).toBe(false);
  });
});
