import { SignInFixCard } from '../components/acp/SignInFixCard';
import { ErrorCard } from '../components/common/ErrorCard';
import { WhatsNewCard } from '../components/updates/WhatsNewCard';
import { rememberWhatsNew } from '../lib/update-schedule';

// The sign-in fix card and the shared error card as they sit in a chat's dock, drawn over the cockpit (dev harness only).
export function FlowCardsPreview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', left: 24, top: 24, width: 520, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg)', padding: 12, borderRadius: 12 }}>
      <SignInFixCard
        label="Claude"
        hint="Type /login in the terminal."
        kept="add the date format to the invoice header"
        other={{ id: 'codex', label: 'Codex' }}
        onOpen={() => undefined}
        onRetry={() => Promise.reject(new Error('still signed out'))}
        onUseOther={() => undefined}
      />
      <ErrorCard
        who="Codex"
        what="The chat stopped: the agent stopped unexpectedly (exit code 3)"
        can="Restart the chat. Your conversation is kept."
        details="exit code 3 at C:\Users\dev\work\billing-service"
        action={{ label: 'Restart chat', onClick: () => undefined }}
      />
    </div>
  );
}

/** "What is new" after a restart: the note the update left, shown by the real card. */
export function WhatsNewPreview() {
  rememberWhatsNew({
    version: '1.0.28',
    notes: '- Updates wait for your agents now\n- A sign-in that ended becomes one button\n- Problems are listed in one place\n- Small fixes',
    chats: 4,
  });
  return (
    <div className="cockpit">
      <WhatsNewCard transport={{ check: async () => null, busy: async () => [], install: async () => undefined, currentVersion: async () => '1.0.28' }} />
    </div>
  );
}
