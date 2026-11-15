// What a tap on a push notification (or one of its buttons) does, with every browser API passed in so a
// unit test can run it without a service worker. `src/sw.ts` wires the real ones.
import { clickIntent, type OpenTarget, type PushAct, type PushChoice } from './push-core';

export interface ClickedNotification {
  tag?: string;
  data?: { pane_id?: string; item_id?: string; act?: PushAct; target?: 'questions' };
}

export interface ClickDeps {
  /** `fetch`, called with an absolute URL. */
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;
  /** The scope the worker serves, to make an absolute URL from the route path. */
  scope: string;
  /** Open (or focus) the app on what the notification is about. */
  open: (target: OpenTarget) => Promise<void>;
  /** Show a follow-up notification (used when the answer did not go through). */
  notify: (title: string, options: { body: string; tag?: string; data: { pane_id?: string; item_id?: string } }) => Promise<void>;
}

async function postAnswer(deps: ClickDeps, url: string, token: string, choice: PushChoice): Promise<boolean> {
  try {
    const res = await deps.fetch(new URL(url, deps.scope).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, choice }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * A button on a notification answers through the one-shot route (`/push/act`: the PC re-checks that the
 * phone may answer, and that the question or prompt is still the one shown). Anything else, a tap on the
 * body, a risky approval (it carries no buttons) or a button that does not fit the token, opens the app.
 */
export async function handleNotificationClick(action: string, notification: ClickedNotification, deps: ClickDeps): Promise<'answered' | 'failed' | 'opened'> {
  const intent = clickIntent(action, notification.data);
  if (intent.type === 'open') {
    await deps.open({ itemId: intent.itemId, paneId: intent.paneId, view: intent.view });
    return 'opened';
  }
  if (await postAnswer(deps, intent.url, intent.token, intent.choice)) return 'answered';
  // Expired, already answered at the PC, or offline: say so and let a tap open the card.
  await deps.notify("Couldn't send your answer", {
    body: 'It may already be answered. Tap to see.',
    tag: notification.tag,
    data: { pane_id: notification.data?.pane_id, item_id: notification.data?.item_id },
  });
  return 'failed';
}
