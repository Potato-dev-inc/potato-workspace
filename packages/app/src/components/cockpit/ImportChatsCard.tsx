// "Bring my chats": the one first-start card in the Inbox. It shows once, after the welcome is done and
// chat search is on. It reads nothing: "Bring my chats" opens the Bring panel (the first step that looks at an
// agent folder), and "Dismiss" remembers the answer. Nothing leaves this computer.
import { errorSentence } from '../../lib/sayError';
import { useCallback, useEffect, useState } from 'react';
import { chatImportApi, type ImportApi, type ImportState } from '../../lib/chatImport';
import { loadSettings } from '../../lib/settings';
import { BringChatsPanel, BRING_CHATS_TITLE_ID } from '../history/BringChatsPanel';
import { CardButton, InboxCard } from './InboxCard';
import { Sheet } from './Sheet';

export const IMPORT_CARD_TITLE = 'Bring your chats here';
export const IMPORT_CARD_BODY = 'Bring the chats your other agents kept on this PC. Nothing leaves this computer.';

/** True once the first-run welcome was finished or skipped (`onboarding_done: true` in the settings file). */
async function welcomeDone(): Promise<boolean> {
  const settings = await loadSettings();
  return settings.onboarding_done === true;
}

export function ImportChatsCard({ api = chatImportApi, isWelcomeDone = welcomeDone }: { api?: ImportApi; isWelcomeDone?: () => Promise<boolean> }) {
  const [state, setState] = useState<ImportState | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [panel, setPanel] = useState(false);
  const [gone, setGone] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .state()
      .then((next) => setState(next))
      .catch(() => setState(null));
  }, [api]);

  // Reads the saved answers only. The welcome is checked only when the card could show at all.
  useEffect(() => {
    let live = true;
    api
      .state()
      .then((next) => {
        if (!live) return;
        setState(next);
        if (next.asked || !next.indexEnabled) return;
        return isWelcomeDone()
          .then((done) => live && setWelcome(done))
          .catch(() => undefined);
      })
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [api, isWelcomeDone]);

  // Closing the panel re-reads the answer: "Add" marks the question as answered, so the card goes away.
  const closePanel = () => {
    setPanel(false);
    refresh();
  };

  const notNow = async () => {
    setNote(null);
    try {
      await api.dismiss();
      setGone(true);
    } catch (error) {
      setNote(errorSentence(error));
    }
  };

  const shown = !gone && state !== null && !state.asked && state.indexEnabled && welcome;
  if (!shown) return null;

  return (
    <>
      <ul className="ib-list" aria-label="Old chats">
        <li>
          <InboxCard
            kind="note"
            glyph="notice"
            info
            title={IMPORT_CARD_TITLE}
            reason={IMPORT_CARD_BODY}
            note={note}
            data={{ 'data-testid': 'import-chats-card' }}
            actions={
              <CardButton tone="primary" onClick={() => setPanel(true)}>
                Bring my chats
              </CardButton>
            }
            more={
              <CardButton tone="plain" role="dismiss" onClick={() => void notNow()}>
                Dismiss
              </CardButton>
            }
          />
        </li>
      </ul>
      {panel && (
        <Sheet labelledBy={BRING_CHATS_TITLE_ID} role="dialog" onClose={closePanel}>
          {/* The card's button is the person's own press: the panel looks at the agents' folders when it opens. */}
          <BringChatsPanel api={api} onClose={closePanel} />
        </Sheet>
      )}
    </>
  );
}
