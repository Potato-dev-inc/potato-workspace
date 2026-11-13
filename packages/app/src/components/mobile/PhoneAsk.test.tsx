// @vitest-environment jsdom
// P7 (the approval card in the chat) and P8 (the "needs you" pill).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ITEM_HIGH, ITEM_LOW, ITEM_MEDIUM } from '../../dev/attention-fixtures';
import type { AttentionAnswerOutcome, AttentionItem, AttentionSnapshot } from '../../lib/attention';
import type { BridgeClient } from '../../lib/bridge-types';
import { HOLD_MS } from './HoldButton';
import { DockedCard } from './DockedCard';
import { PhoneAskCard } from './PhoneAskCard';
import { PhoneNeedsPill } from './PhoneNeedsPill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const answered: AttentionAnswerOutcome = { outcome: 'answered', choice_label: 'Allowed once', at_ms: 1_700_000_000_000 } as AttentionAnswerOutcome;
const makeBridge = () => {
  const answerAttention = vi.fn(async () => answered);
  return { bridge: { answerAttention } as unknown as BridgeClient, answerAttention };
};
const snap = (items: AttentionItem[]): AttentionSnapshot => ({ v: 1, rev: 1, counts: { blocking: items.length, ready: 0 }, items });
const choice = (id: string) => host.querySelector(`[data-choice="${id}"]`) as HTMLButtonElement;

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node); });
}

describe('P7: the approval card in the chat', () => {
  it('shows who asks, one sentence, the exact command, a risk line and two buttons', async () => {
    const { bridge } = makeBridge();
    await render(<PhoneAskCard item={ITEM_LOW} bridge={bridge} canAnswer />);
    expect(host.querySelector('.ph-ask-who')?.textContent).toBe('Billing tests asks');
    expect(host.querySelector('.ph-ask-title')?.textContent).toBe('Run tests');
    expect(host.querySelector('[data-testid="phone-ask-command"]')?.textContent).toBe('Run command: npm test (in billing-service)');
    expect(host.querySelector('.ph-ask-risk')?.getAttribute('data-risk')).toBe('low');
    expect(host.querySelector('.ph-ask-risk')?.textContent).toContain('Low risk');
    expect(host.querySelectorAll('.ph-ask-btn')).toHaveLength(2);
  });

  it('a low-risk Allow is one tap and goes through the PC check with the fingerprint', async () => {
    const { bridge, answerAttention } = makeBridge();
    await render(<PhoneAskCard item={ITEM_LOW} bridge={bridge} canAnswer />);
    await act(async () => { choice('allow_once').click(); await Promise.resolve(); });
    expect(answerAttention).toHaveBeenCalledTimes(1);
    const [id, body] = answerAttention.mock.calls[0] as unknown as [string, { choice: string; fingerprint: string }];
    expect(id).toBe(ITEM_LOW.id);
    expect(body).toMatchObject({ choice: 'allow_once', fingerprint: 'f3c1a9b200d4e7a1' });
  });

  it('after the answer the card shrinks to one line', async () => {
    const { bridge } = makeBridge();
    await render(<PhoneAskCard item={ITEM_LOW} bridge={bridge} canAnswer />);
    await act(async () => { choice('allow_once').click(); await Promise.resolve(); });
    expect(host.querySelector('[data-testid="phone-ask-card"]')).toBeNull();
    const line = host.querySelector('[data-testid="phone-ask-line"]');
    expect(line?.textContent).toContain('Billing tests');
    expect(line?.textContent).toContain('Allowed once');
  });

  it('a high-risk Allow needs a one-second press and hold; a tap or an early release sends nothing', async () => {
    const { bridge, answerAttention } = makeBridge();
    await render(<PhoneAskCard item={ITEM_HIGH} bridge={bridge} canAnswer />);
    expect(host.querySelector('.ph-ask-risk')?.getAttribute('data-risk')).toBe('high');
    const allow = choice('allow_once');
    // A plain tap (down and up at once): nothing.
    await act(async () => { allow.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); allow.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); allow.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLD_MS + 100); });
    expect(answerAttention).not.toHaveBeenCalled();
    // Held for a second: it is sent.
    await act(async () => { allow.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLD_MS - 100); });
    expect(answerAttention).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(answerAttention).toHaveBeenCalledTimes(1);
    expect((answerAttention.mock.calls[0] as unknown as [string, { choice: string }])[1].choice).toBe('allow_once');
  });

  it('the safe choice of a high-risk card is one tap and takes the focus', async () => {
    const { bridge, answerAttention } = makeBridge();
    await render(<PhoneAskCard item={ITEM_HIGH} bridge={bridge} canAnswer autoFocus />);
    expect((document.activeElement as HTMLElement).dataset.choice).toBe('deny');
    await act(async () => { choice('deny').click(); await Promise.resolve(); });
    expect(answerAttention).toHaveBeenCalledTimes(1);
  });

  it('a keyboard can hold Space for one second; a screen reader double tap needs a second activation', async () => {
    const { bridge, answerAttention } = makeBridge();
    await render(<PhoneAskCard item={ITEM_HIGH} bridge={bridge} canAnswer />);
    const allow = choice('allow_once');
    await act(async () => { allow.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLD_MS + 50); });
    expect(answerAttention).toHaveBeenCalledTimes(1);
    answerAttention.mockClear();
    await render(<PhoneAskCard key="again" item={ITEM_HIGH} bridge={bridge} canAnswer />);
    const again = choice('allow_once');
    await act(async () => { again.click(); });
    expect(answerAttention).not.toHaveBeenCalled();
    expect(again.textContent).toBe('Press again to confirm');
    await act(async () => { again.click(); await Promise.resolve(); });
    expect(answerAttention).toHaveBeenCalledTimes(1);
  });

  it('a phone that may only watch sees the card without buttons', async () => {
    await render(<PhoneAskCard item={ITEM_LOW} bridge={null} canAnswer={false} />);
    expect(host.querySelectorAll('.ph-ask-btn')).toHaveLength(0);
    expect(host.querySelector('.ph-ask-status')?.textContent).toBeTruthy();
  });

  it('the docked card of the open chat is this card when it sits in the conversation', async () => {
    const { bridge } = makeBridge();
    await render(<DockedCard snapshot={snap([ITEM_LOW])} paneId={ITEM_LOW.pane!.id} bridge={bridge} canAnswer onOpenPane={() => undefined} onOpenItem={() => undefined} inChat />);
    expect(host.querySelector('[data-testid="phone-ask-card"]')).not.toBeNull();
    expect(host.querySelector('.ph-appr')).toBeNull();
  });
});

describe('P8: the needs-you pill', () => {
  const pill = (items: AttentionItem[], over: { onJump?: (id: string) => void; canAnswer?: boolean; active?: string } = {}) => {
    const { bridge, answerAttention } = makeBridge();
    return {
      answerAttention,
      node: <PhoneNeedsPill snapshot={snap(items)} activePaneId={over.active ?? 'pane-some-other-chat'} bridge={bridge} canAnswer={over.canAnswer ?? true} onJump={over.onJump ?? (() => undefined)} />,
    };
  };

  it('shows another agent that needs you, with +N for the rest', async () => {
    await render(pill([ITEM_HIGH, ITEM_MEDIUM, ITEM_LOW]).node);
    const el = host.querySelector('[data-testid="needs-pill"]')!;
    expect(el.textContent).toContain('Fix login redirect');
    expect(el.textContent).toContain('+2');
  });

  it('is not there when only this chat needs you', async () => {
    await render(pill([ITEM_LOW], { active: ITEM_LOW.pane!.id }).node);
    expect(host.querySelector('[data-testid="needs-pill"]')).toBeNull();
  });

  it('answers a low-risk question with Yes or No right on the pill', async () => {
    const { node, answerAttention } = pill([ITEM_LOW]);
    await render(node);
    const yes = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Yes')!;
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'No')).toBe(true);
    await act(async () => { yes.click(); await Promise.resolve(); });
    expect(answerAttention).toHaveBeenCalledTimes(1);
    expect((answerAttention.mock.calls[0] as unknown as [string, { choice: string }])[1].choice).toBe('allow_once');
  });

  it('a risky question has no Yes or No on the pill: a tap jumps to that chat', async () => {
    const onJump = vi.fn();
    await render(pill([ITEM_HIGH], { onJump }).node);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Yes');
    await act(async () => { (host.querySelector('.ph-pill-main') as HTMLButtonElement).click(); });
    expect(onJump).toHaveBeenCalledWith(ITEM_HIGH.pane!.id);
  });

  it('a phone that cannot answer gets the jump but no Yes or No', async () => {
    await render(pill([ITEM_LOW], { canAnswer: false }).node);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Yes');
    expect(host.querySelector('.ph-pill-main')).not.toBeNull();
  });
});
