import { errorSentence } from '../../../lib/sayError';
import { useState } from 'react';
import { cardActions, cardMeta, cardTitle, githubUrl, warRoomLine, type TeamApi, type TeamCard as Card } from '../../../lib/team';
import { tauri } from '../../../lib/tauri';
import { CardButton, InboxCard } from '../InboxCard';
import { MergeSheet } from './MergeSheet';
import { QueueSheet } from './QueueSheet';

const errText = (err: unknown): string => (errorSentence(err));

/**
 * A teammate's push or PR, in Inbox › Team. Everything in `card.event` came from a teammate and is
 * untrusted: it is rendered as plain text only, and the note always in quotes. Buttons: the one
 * action that fits (Pull now, or Queue my agent), Dismiss, and on an open GitHub PR "Merge when green"
 * (a sheet explains it first; GitHub does the merge). Team cards never use the loud button: Needs you
 * is the only loud thing in the Inbox.
 */
export function TeamCard({ card, api, now, onDone }: { card: Card; api: TeamApi; now: number; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const actions = cardActions(card);
  const e = card.event;
  // War Room cards (a PR opened, a push to the default branch) link to GitHub.
  const url = warRoomLine(e) ? githubUrl(e) : null;

  const run = async (what: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    try {
      const out = await what();
      if (typeof out === 'string') setMessage(out);
      onDone?.();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <InboxCard
        kind="team"
        glyph="notice"
        title={cardTitle(e)}
        age={now - e.atMs}
        reason={cardMeta(e)}
        data={{ 'data-team-card': card.id }}
        body={
          <>
            {e.note && <p className="ib-quote">“{e.note}”</p>}
            {(message ?? actions.note) && <p className="ib-note">{message ?? actions.note}</p>}
            {error && (
              <p className="ib-error" role="alert">
                {error}
              </p>
            )}
          </>
        }
        actions={
          <>
            {actions.primary === 'pull' && (
              <CardButton tone="secondary" role="answer" disabled={busy} onClick={() => void run(() => api.pull(card.id))}>
                Pull now
              </CardButton>
            )}
            {actions.primary === 'queue' && (
              <CardButton tone="secondary" role="answer" disabled={busy} onClick={() => setQueueOpen(true)}>
                Queue my agent…
              </CardButton>
            )}
            {actions.mergeWhenGreen && (
              <CardButton tone="secondary" role="answer" disabled={busy} onClick={() => setMergeOpen(true)}>
                Merge when green
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
      {mergeOpen && (
        <MergeSheet
          card={card}
          api={api}
          onClose={() => setMergeOpen(false)}
          onDone={(text) => {
            setMessage(text);
            setMergeOpen(false);
            onDone?.();
          }}
        />
      )}
      {queueOpen && (
        <QueueSheet
          card={card}
          onClose={() => setQueueOpen(false)}
          onQueue={async (paneId, when) => {
            await api.queue(card.id, paneId, when);
            setQueueOpen(false);
            onDone?.();
          }}
        />
      )}
    </>
  );
}
