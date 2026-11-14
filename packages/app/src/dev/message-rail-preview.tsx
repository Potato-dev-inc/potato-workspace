import { useEffect, useRef } from 'react';
import { ChatComposer } from '../components/chat/ChatComposer';
import { SessionChatView } from '../components/chat/SessionChatView';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';

// The message rail beside the scroll bar, drawn over the cockpit: a chat of 14 turns (28 messages), scrolled to the
// middle, with the pointer on one dash so the card shows. Dev evidence only.
const ASKS = [
  'The login page shows a blank screen after I sign in. Can you fix it?',
  'Keep the loading state simple, just the spinner we already have.',
  'Does it also work when the session has expired?',
  'Should the draft stay when the session ends?',
  'Keep the draft.',
  'Can you make the error message friendlier? "401" means nothing to people.',
  'One more: the "Forgot password" link is hard to see in dark mode.',
  'Please add a test for the expired session.',
  'Run the whole suite once more.',
  'Looks good. Update the changelog.',
  'Also mention it in the docs.',
  'Thanks! Commit it please.',
  'Open a pull request.',
  'Great, merge it when the checks pass.',
];
const ANSWERS = [
  'Found it: after sign-in the redirect reads user.profile before it has loaded, so the page throws and shows nothing. The redirect now waits for the profile.',
  'Done. The page uses the existing Spinner while the profile loads, with no new styles.',
  'Good question. When the session expired the hook returned null and we still went to /home. Expired sessions now go back to the sign-in form with a short note.',
  'Kept. The draft stays and comes back after signing in again.',
  'Done. Nothing else changed.',
  'Changed it to: "Your sign-in ended. Please sign in again." Also in Traditional Chinese.',
  'The link used a fixed grey. It now uses the theme text colour, with an underline on hover.',
  'Added. It fails without the fix and passes with it.',
  'All 49 tests pass.',
  'Changelog updated under the next release.',
  'Added a short note to the sign-in page of the docs.',
  'Committed: "login: wait for profile, handle expired session, clearer error".',
  'Opened the pull request. CI is running.',
  'Waiting for the checks. I will merge as soon as they are green.',
];

function items(): ChatItem[] {
  const out: ChatItem[] = [];
  ASKS.forEach((ask, n) => {
    out.push({ kind: 'user', id: `u${n}`, at: null, text: ask });
    out.push({ kind: 'toolCall', id: `c${n}`, at: null, callId: `k${n}`, name: 'Read', summary: `src/page${n}.tsx`, paths: [`src/page${n}.tsx`] });
    out.push({ kind: 'toolResult', id: `r${n}`, at: null, callId: `k${n}`, ok: true, output: 'ok' });
    out.push({ kind: 'assistant', id: `a${n}`, at: null, text: ANSWERS[n]!, model: null, finalAnswer: true });
    out.push({ kind: 'turnEnd', id: `e${n}`, at: null, outcome: 'completed', durationMs: 40_000 });
  });
  return out;
}

export function Preview() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timers: number[] = [];
    timers.push(
      window.setTimeout(() => {
        const body = box.current?.querySelector<HTMLElement>('.ck-chat-body');
        if (body) body.scrollTop = body.scrollHeight * 0.45;
      }, 300),
    );
    timers.push(
      window.setTimeout(() => {
        const rail = box.current?.querySelector<HTMLElement>('[data-testid="message-rail"]');
        if (!rail) return;
        const dash = rail.querySelectorAll<HTMLElement>('[data-testid="message-rail-dash"]')[17];
        const top = rail.getBoundingClientRect().top + (dash ? parseFloat(dash.style.top) : 100) + 1;
        rail.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: top }));
      }, 900),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <div ref={box} style={{ width: 700, height: 600, margin: '0 auto', border: '1px solid var(--sep)', borderRadius: 12, overflow: 'hidden' }}>
        <SessionChatView
          state="ready"
          reason={null}
          source="acp"
          turns={groupTurns(items()).turns}
          model="Agent"
          cliVersion={null}
          paneId="preview-rail"
          composer={<ChatComposer onSend={async () => null} blockedReason={null} />}
        />
      </div>
    </div>
  );
}
