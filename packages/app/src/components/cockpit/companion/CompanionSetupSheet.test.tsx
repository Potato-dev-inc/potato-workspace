// @vitest-environment jsdom
// The five steps of "Make your companion": an agent that cannot take messages is shown with its reason and cannot be
// picked; the button needs a name, a folder and a usable agent; a face sets the default name until the person types.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCompanionTransport, type CompanionAgentOption, type CompanionView } from '../../../lib/companion';
import type { ShipApi } from '../../../lib/ship-api';
import { CompanionSetupSheet } from './CompanionSetupSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const AGENTS: CompanionAgentOption[] = [
  { id: 'claude', label: 'Claude', ok: true, reason: null },
  { id: 'codex', label: 'Codex', ok: false, reason: "Chat can't send messages to this agent yet." },
];

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label))!;
const nameInput = () => host.querySelector<HTMLInputElement>('input.ck-companion-input')!;

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render(
  agents: CompanionAgentOption[] = AGENTS,
  ship: Pick<ShipApi, 'pickFolder'> = { pickFolder: vi.fn(async () => null) },
  existing: CompanionView[] = [],
) {
  const transport = fakeCompanionTransport({ agents, companions: existing, memory: { soul: 'Warm and short.' } });
  const onCreated = vi.fn();
  const onClose = vi.fn();
  await act(async () =>
    root.render(<CompanionSetupSheet transport={transport} ship={ship} companions={existing} onClose={onClose} onCreated={onCreated} />),
  );
  await act(async () => {});
  return { transport, onCreated, onClose, ship };
}

describe('CompanionSetupSheet', () => {
  it('reads the agents, shows the reason for one that cannot take messages, and picks a usable one', async () => {
    await render();
    expect(button('Codex').disabled).toBe(true);
    expect(host.textContent).toContain("Chat can't send messages to this agent yet.");
    expect(button('Claude').getAttribute('aria-checked')).toBe('true');
  });

  it('names the face by default, and keeps the typed name when the face changes', async () => {
    await render();
    expect(nameInput().value).toBe('Mochi');
    act(() => host.querySelector<HTMLButtonElement>('button[title="Bit"]')!.click());
    expect(nameInput().value).toBe('Bit');
    setValue(nameInput(), 'Pip');
    act(() => host.querySelector<HTMLButtonElement>('button[title="Nib"]')!.click());
    expect(nameInput().value).toBe('Pip');
  });

  it('makes the companion with the chosen face, name, agent, talk and folder', async () => {
    const { transport, onCreated } = await render();
    act(() => host.querySelector<HTMLButtonElement>('button[title="Lumen"]')!.click());
    setValue(nameInput(), 'Lumi');
    act(() => button('Plain and direct').click());
    expect(button('Wake up Lumi').disabled).toBe(false);
    await act(async () => button('Wake up Lumi').click());
    const create = transport.calls.find((c) => c.method === 'create');
    expect(create?.args[0]).toEqual({
      name: 'Lumi',
      avatar: 'lumen',
      accent: 'potato',
      persona: 'plain',
      agentType: 'claude',
      folder: '',
      autoStart: true,
      memoryReview: true,
      napAt: { h: 4, m: 0 },
      checkins: [],
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('does not list plain shells, but keeps other unusable agents greyed with their reason', async () => {
    await render([
      { id: 'claude', label: 'Claude', ok: true, reason: null },
      { id: 'codex', label: 'Codex', ok: false, reason: "Chat can't send messages to this agent yet." },
      { id: 'powershell', label: 'PowerShell', ok: false, reason: "Chat can't send messages to this agent yet." },
      { id: 'bash', label: 'Bash', ok: false, reason: "Chat can't send messages to this agent yet." },
    ]);
    expect(host.textContent).not.toContain('PowerShell');
    expect(host.textContent).not.toContain('Bash');
    expect(button('Codex').disabled).toBe(true);
  });

  it('draws each face about 40 px wide', async () => {
    await render();
    expect(host.querySelector('button[title="Bit"] svg')?.getAttribute('width')).toBe('40');
  });

  it('will not make a companion with an empty name', async () => {
    await render();
    setValue(nameInput(), '   ');
    expect(button('Wake up it').disabled).toBe(true);
  });

  it('blocks the button when no agent can take messages', async () => {
    await render([{ id: 'codex', label: 'Codex', ok: false, reason: "Chat can't send messages to this agent yet." }]);
    expect(button('Wake up Mochi').disabled).toBe(true);
  });

  it('starts with a folder of its own that Potato Workspace makes, not the open project', async () => {
    await render();
    expect(host.querySelector('.ck-companion-folder-name')?.textContent).toBe('A folder of its own, made for it');
    expect(host.textContent).toContain('a folder of its own that Potato Workspace makes');
  });

  it('a folder the person picks holds a folder of its own for the companion, never the picked folder itself', async () => {
    const ship = { pickFolder: vi.fn(async () => ({ path: 'D:\\notes', name: 'notes', state: 'folder' as const, last_used_ms: 0 })) };
    const { transport } = await render(AGENTS, ship as unknown as Pick<ShipApi, 'pickFolder'>);
    await act(async () => button('Change folder').click());
    expect(host.querySelector('.ck-companion-folder-name')?.textContent).toBe('D:\\notes\\mochi');
    expect(host.textContent).toContain('Its files stay on this computer, in D:\\notes\\mochi.');
    // It follows the name.
    setValue(nameInput(), 'Pipi');
    expect(host.querySelector('.ck-companion-folder-name')?.textContent).toBe('D:\\notes\\pipi');
    await act(async () => button('Wake up Pipi').click());
    const create = transport.calls.find((c) => c.method === 'create');
    expect((create?.args[0] as { folder: string }).folder).toBe('D:\\notes\\pipi');
  });

  it('shows the refusal of a broad folder as a plain sentence, without the code', async () => {
    const { transport } = await render();
    transport.create = () =>
      Promise.reject(new Error("COMPANION_FOLDER_BROAD: Pick a folder of its own. Your Desktop has other projects in it, and agents there would read Mochi's notes. Try C:\\x\\mochi."));
    await act(async () => button('Wake up Mochi').click());
    const alert = host.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toBe("Pick a folder of its own. Your Desktop has other projects in it, and agents there would read Mochi's notes. Try C:\\x\\mochi.");
    expect(button('Wake up Mochi').disabled).toBe(false);
  });

  describe('a second companion', () => {
    const mochi: CompanionView = {
      id: 'mochi',
      name: 'Mochi',
      avatar: 'mochi',
      isDefault: true,
      persona: 'calm',
      agentType: 'claude',
      agentLabel: 'Claude',
      folderName: 'mochi',
      state: 'idle',
      stateLine: 'Here.',
      paneId: 'companion-mochi',
      needs: null,
      pendingMemory: 0,
      nextCheckin: null,
      restarts: 0,
      autoStart: true,
    };

    it('says it is another one, picks its own face, name and colour, and starts empty', async () => {
      const { transport, onCreated } = await render(AGENTS, undefined, [mochi]);
      expect(host.textContent).toContain('Make another companion');
      act(() => host.querySelector<HTMLButtonElement>('button[title="Kit"]')!.click());
      setValue(nameInput(), 'Kit');
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Sky"]')!.click());
      await act(async () => button('Wake up Kit').click());
      const create = transport.calls.find((c) => c.method === 'create');
      expect(create?.args[0]).toMatchObject({ name: 'Kit', avatar: 'kit', accent: 'sky' });
      expect(transport.calls.some((c) => c.method === 'saveMemory')).toBe(false);
      expect(onCreated).toHaveBeenCalledTimes(1);
    });

    it('can copy how another companion talks, and only that', async () => {
      const { transport } = await render(AGENTS, undefined, [mochi]);
      setValue(nameInput(), 'Pip');
      act(() => button('Copy how Mochi talks').click());
      expect(host.textContent).toContain('Only its "Who it is" text is copied');
      await act(async () => button('Wake up Pip').click());
      const saves = transport.calls.filter((c) => c.method === 'saveMemory');
      expect(saves).toHaveLength(1);
      expect(saves[0].args).toEqual(['pip', 'soul', 'Warm and short.']);
    });

    it('the first companion sheet has no "Start from" choice', async () => {
      await render();
      expect(host.textContent).not.toContain('Start from');
    });
  });
});
