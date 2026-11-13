// @vitest-environment jsdom
// With a header slot (the pane header) the chat has no header row of its own: the view switch, the side question
// button and the Share menu are drawn in the slot, and the model name is left out (it is in the message box).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let slot: HTMLSpanElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  slot = document.createElement('span');
  document.body.append(slot, host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  slot.remove();
});

const show = (compact: boolean, withSlot = true) =>
  act(() =>
    root.render(
      <SessionChatView
        state="ready"
        reason={null}
        turns={[]}
        model="Haiku 5.5"
        cliVersion={null}
        headerExtra={<button>Ask aside</button>}
        headerMenu={<button>Share</button>}
        headerSlot={withSlot ? { el: slot, compact } : undefined}
      />,
    ),
  );

describe('chat header folded into the pane header', () => {
  it('draws Ask aside, the Summary / Normal / Verbose switch and Share in the slot, with no second header row', () => {
    show(false);
    expect(host.querySelector('header')).toBeNull();
    expect(host.textContent).not.toContain('Haiku 5.5');
    expect(slot.textContent).toContain('Ask aside');
    expect([...slot.querySelectorAll('.ck-chat-mode')].map((b) => b.textContent)).toEqual(['Summary', 'Normal', 'Verbose']);
    expect(slot.textContent).toContain('Share');
  });

  it('a tight header shows the view switch as one pill', () => {
    show(true);
    expect(slot.querySelector('.ck-chat-mode-pill')?.textContent).toContain('Normal');
    expect(slot.querySelectorAll('.ck-chat-mode')).toHaveLength(0);
  });

  it('without a slot the chat keeps its own header (phone, history, split view)', () => {
    show(false, false);
    expect(host.querySelector('header')?.textContent).toContain('Haiku 5.5');
  });
});
