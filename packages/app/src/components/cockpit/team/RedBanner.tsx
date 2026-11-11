import { useState } from 'react';
import { githubUrl, isRedBanner, redBannerText, type TeamApi, type TeamCard, type TeamState } from '../../../lib/team';
import { tauri } from '../../../lib/tauri';
import { CardButton, InboxCard } from '../InboxCard';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * War Room: "main is red in acme/app · CI", on top of the Inbox. One per red default branch (a
 * `ci_failed` card without a PR). "Claim it" tells the team I'm on it; then every teammate's banner
 * says "<name> is on it", and mine offers Release. Two claims at once: the earliest click wins on
 * every app (Rust `store::earliest_claim`). It goes when CI on that branch passes, a later push
 * lands, or I dismiss it. Everything here came from GitHub through my own `gh`: plain text only.
 */
export function RedBanners({ state, api, now, onDone }: { state: TeamState | null; api: TeamApi; now: number; onDone: () => void }) {
  if (!state?.enabled) return null;
  const red = state.cards.filter(isRedBanner);
  if (red.length === 0) return null;
  return (
    <ul className="ib-list" aria-label="Red branches">
      {red.map((card) => (
        <li key={card.id}>
          <RedBanner card={card} api={api} now={now} onDone={onDone} />
        </li>
      ))}
    </ul>
  );
}

function RedBanner({ card, api, now, onDone }: { card: TeamCard; api: TeamApi; now: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = card.claim ?? null;
  const url = githubUrl(card.event);

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InboxCard
      kind="team"
      glyph="needs"
      title={redBannerText(card.event)}
      age={now - card.event.atMs}
      reason={claim ? `${claim.mine ? 'You are' : `${claim.display} is`} on it` : 'Nobody is on it yet.'}
      data={{ 'data-team-red': card.id }}
      body={
        error ? (
          <p className="ib-error" role="alert">
            {error}
          </p>
        ) : undefined
      }
      actions={
        <>
          {!claim && (
            <CardButton tone="secondary" role="answer" disabled={busy} onClick={() => void run(() => api.claimCi(card.id, true))}>
              Claim it
            </CardButton>
          )}
          {claim?.mine && (
            <CardButton tone="secondary" role="answer" disabled={busy} onClick={() => void run(() => api.claimCi(card.id, false))}>
              Release
            </CardButton>
          )}
          {url && (
            <CardButton tone="plain" role="open" onClick={() => void tauri.openExternalUrl(url)}>
              Open on GitHub
            </CardButton>
          )}
        </>
      }
      more={
        <CardButton tone="plain" role="dismiss" disabled={busy} onClick={() => void run(() => api.dismissCard(card.id))}>
          Dismiss
        </CardButton>
      }
    />
  );
}
