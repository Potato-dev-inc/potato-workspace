// @vitest-environment jsdom
// "<PC> isn't answering" under the message box is not true once the far PC is back (its host is a new object then): the note goes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostProvider } from '../../lib/host/context';
import { ALL_CAPS, type Host } from '../../lib/host/host';
import { ChatComposer } from './ChatComposer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const far = (): Host => ({ place: { kind: 'pc', node: 'n', name: 'Box' }, live: true, caps: ALL_CAPS, invoke: async () => undefined as never, listen: async () => () => undefined });

let root: Root | null = null;
afterEach(() => act(() => root?.unmount()));

describe('ChatComposer note after a reconnect', () => {
  it('clears the "isn\'t answering" note when the far host is a new one', async () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    const view = (h: Host) => (
      <HostProvider host={h}>
        <ChatComposer onSend={async () => "Box isn't answering. Your message is kept here."} blockedReason={null} />
      </HostProvider>
    );
    await act(async () => root!.render(view(far())));
    const area = box.querySelector('textarea')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(area, 'hello');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void box.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(box.querySelector('[data-testid="chat-composer-note"]')?.textContent).toContain("isn't answering");
    await act(async () => root!.render(view(far())));
    expect(box.querySelector('[data-testid="chat-composer-note"]')?.textContent ?? '').not.toContain("isn't answering");
  });
});
