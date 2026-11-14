// Potato in the quiet places (never inside a running chat): asleep when there are no chats, loading while the PC connects,
// celebrating when nothing needs you, worried when the PC cannot be reached. One per screen; the art stands still when the
// person prefers reduced motion (PotatoFace does that).
import type { ReactNode } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { writeDraft } from '../../lib/composerDraft';
import { PotatoFace, type PotatoState } from '../cockpit/PotatoFace';
import '../../styles/phone-shell.css';

export type QuietKind = 'empty' | 'loading' | 'done' | 'away';

const ART: Record<QuietKind, { state: PotatoState; title: MessageKey | null; body: MessageKey }> = {
  empty: { state: 'sleep', title: 'phone.empty.title', body: 'phone.empty.body' },
  loading: { state: 'loading', title: null, body: 'phone.loading' },
  done: { state: 'celebrate', title: null, body: 'phone.allDone' },
  away: { state: 'error', title: null, body: 'phone.away' },
};

const STARTERS: Array<{ label: MessageKey; text: MessageKey }> = [
  { label: 'phone.sh.starter1', text: 'phone.sh.starter1Text' },
  { label: 'phone.sh.starter2', text: 'phone.sh.starter2Text' },
  { label: 'phone.sh.starter3', text: 'phone.sh.starter3Text' },
];

export function PhoneQuiet({
  kind,
  compact = false,
  children,
  onStarter,
}: {
  kind: QuietKind;
  /** A smaller one that sits above a list. */
  compact?: boolean;
  children?: ReactNode;
  /** The empty state offers three starters; one puts its sentence in the new chat's box and calls this to open that screen. */
  onStarter?: () => void;
}) {
  const t = useT();
  const art = ART[kind];
  return (
    <div className="ph-quiet" data-testid="phone-quiet" data-kind={kind} data-compact={compact || undefined} role="status">
      <PotatoFace state={art.state} size={compact ? 64 : 96} />
      {art.title && <b>{t(art.title)}</b>}
      <p>{t(art.body)}</p>
      {children}
      {kind === 'empty' && onStarter && (
        <div className="ph-starters" data-testid="phone-starters">
          <p className="ph-starters-title">{t('phone.sh.startersTitle')}</p>
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className="ph-starter"
              onClick={() => {
                writeDraft('new-chat', t(starter.text));
                onStarter();
              }}
            >
              {t(starter.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
