import { describe, expect, it, vi } from 'vitest';
import { handleNotificationClick, type ClickDeps } from './notification-click';
import { parsePushPayload, planNotification } from './push-core';

/** A notification as the service worker would hold it: built from the same plan the push handler shows. */
function shown(payload: Record<string, unknown>) {
  const plan = planNotification(parsePushPayload(JSON.stringify(payload)), '/');
  return { tag: plan.options.tag, data: plan.options.data, actions: plan.options.actions?.map((a) => a.action) ?? [] };
}

function deps(ok = true) {
  const calls: { url: string; body: unknown }[] = [];
  const d: ClickDeps = {
    fetch: vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok };
    }),
    scope: 'https://pm.example.com/',
    open: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
  };
  return { d, calls };
}

const QUESTION = { kind: 'question', title: 'Kilo · Needs you', body: 'Question · Deploy?\nKilo', tag: 'pm-q1', item_id: 'it1', act: { url: '/bridge/push/act', token: 'T', yes_no: true } };
const APPROVAL = { kind: 'waiting_input', title: 'Kilo · Needs you', body: 'Run command: ls', tag: 'pm-p1', pane_id: 'p1', act: { url: '/bridge/push/act', token: 'A' } };

describe('answering from a notification', () => {
  it('a yes/no question shows Yes and No, and each answers through the one-shot route', async () => {
    const n = shown(QUESTION);
    expect(n.actions).toEqual(['yes', 'no']);
    const { d, calls } = deps();
    expect(await handleNotificationClick('yes', n, d)).toBe('answered');
    expect(calls).toEqual([{ url: 'https://pm.example.com/bridge/push/act', body: { token: 'T', choice: 'yes' } }]);
    expect(await handleNotificationClick('no', n, deps().d)).toBe('answered');
    expect(d.open).not.toHaveBeenCalled();
  });

  it('an allow-once approval shows Allow and Deny and answers with allow or deny', async () => {
    const n = shown(APPROVAL);
    expect(n.actions).toEqual(['allow', 'deny']);
    const { d, calls } = deps();
    await handleNotificationClick('deny', n, d);
    expect(calls[0].body).toEqual({ token: 'A', choice: 'deny' });
  });

  it('a risky approval has no buttons, so a tap opens the app and nothing is sent', async () => {
    // The PC leaves the token out of a prompt that is not low risk.
    const risky = shown({ ...APPROVAL, act: undefined });
    expect(risky.actions).toEqual([]);
    const { d, calls } = deps();
    expect(await handleNotificationClick('', risky, d)).toBe('opened');
    expect(calls).toEqual([]);
    expect(d.open).toHaveBeenCalledWith({ itemId: undefined, paneId: 'p1', view: undefined });
  });

  it('a button that does not fit the token opens the app instead of answering', async () => {
    const { d, calls } = deps();
    expect(await handleNotificationClick('allow', shown(QUESTION), d)).toBe('opened');
    expect(await handleNotificationClick('yes', shown(APPROVAL), d)).toBe('opened');
    expect(calls).toEqual([]);
    expect(d.open).toHaveBeenCalledTimes(2);
  });

  it('a plain tap on a question opens its card', async () => {
    const { d, calls } = deps();
    await handleNotificationClick('', shown(QUESTION), d);
    expect(calls).toEqual([]);
    expect(d.open).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'it1' }));
  });

  it('says so when the answer did not go through, and offers the card', async () => {
    const n = shown(QUESTION);
    const refused = deps(false);
    expect(await handleNotificationClick('yes', n, refused.d)).toBe('failed');
    expect(refused.d.notify).toHaveBeenCalledWith("Couldn't send your answer", expect.objectContaining({ tag: 'pm-q1', data: { pane_id: undefined, item_id: 'it1' } }));
    const offline = deps();
    offline.d.fetch = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await handleNotificationClick('no', n, offline.d)).toBe('failed');
    expect(offline.d.notify).toHaveBeenCalledTimes(1);
  });
});
