// A companion's home on the phone (SPEC-1028 section 7): the face and its state, "While you were away", the notes it
// wants to keep, the chat with it (PhoneChatView, the same view as an agent's chat), and Sleep / Wake up. Every
// control needs its device cap: read (`watch`), send (`type`, inside PhoneChatView), keep notes (`answer`), wake or
// sleep (`control`). Monochrome: the face is the only picture, drawn in the text colour.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeClient } from '../../lib/bridge-types';
import type { CompanionTransport, CompanionView, FeedItem, MemoryView, PendingDecision } from '../../lib/companion';
import type { PhoneAbilities } from '../../lib/phone-abilities';
import { Avatar } from '../companion/Avatar';
import { Menu } from '../common/Floating';
import { CompanionFeed, clockLabel, readFeedMark, writeFeedMark } from './CompanionFeed';
import { CompanionPending } from './CompanionPending';
import { CompanionSkills } from './CompanionSkills';
import { PhoneChatView } from './PhoneChatView';
import '../../styles/ph-companion.css';

/** The face on the home is drawn this big (px). */
export const HOME_FACE_PX = 96;

export interface CompanionHomeProps {
  companion: CompanionView;
  bridge: BridgeClient;
  transport: CompanionTransport;
  /** This phone's caps (`watch`, `type`, `answer`, `control`); the PC enforces them too. */
  abilities: PhoneAbilities;
  /** False for an agent that cannot take chat (a shell): the chat is replaced by one plain line. */
  chatAllowed: boolean;
  /** "Open card": the person opens the card the companion is waiting on (`needs.itemId`). */
  onOpenCard: (itemId: string) => void;
  /** Sleep or wake returned the companion's new view. */
  onChanged: (view: CompanionView) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not reach your companion.';
}

export function CompanionHome({ companion, bridge, transport, abilities, chatAllowed, onOpenCard, onChanged }: CompanionHomeProps) {
  const { id, name, state, pendingMemory, needs, nextCheckin, paneId } = companion;
  const asleep = state === 'sleeping';
  // Read once per visit: the feed shows what came after the last time this phone opened the home.
  const seenMark = useMemo(() => readFeedMark(id), [id]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [feedOpen, setFeedOpen] = useState(false);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  // The feed and the notes are read on open and on each state change (and when the note count changes).
  useEffect(() => {
    if (!abilities.canWatch) {
      setFeed([]);
      return;
    }
    let live = true;
    transport
      .feed(id, seenMark)
      .then((items) => {
        if (!live) return;
        // The PC sends the newest first; sorted here too, so the order holds whatever it sends.
        const fresh = items.filter((item) => item.atMs > seenMark).sort((a, b) => b.atMs - a.atMs);
        setFeed(fresh);
        const newest = fresh.reduce((max, item) => Math.max(max, item.atMs), 0);
        if (newest > 0) writeFeedMark(id, newest);
      })
      .catch(() => {
        if (live) setFeed([]);
      });
    return () => {
      live = false;
    };
  }, [transport, id, seenMark, state, abilities.canWatch]);

  useEffect(() => {
    if (!abilities.canWatch) {
      setMemory(null);
      return;
    }
    let live = true;
    transport
      .memory(id)
      .then((next) => {
        if (live) setMemory(next);
      })
      .catch(() => {
        if (live) setMemory(null);
      });
    return () => {
      live = false;
    };
  }, [transport, id, state, pendingMemory, abilities.canWatch]);

  const toggleAgent = (next: 'wake' | 'sleep') => {
    setBusy(next);
    setError(null);
    setMenuOpen(false);
    const job = next === 'wake' ? transport.wake(id) : transport.sleep(id);
    job
      .then(onChanged)
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(null));
  };

  const decide = (itemId: string, decision: PendingDecision) => {
    setBusy(itemId);
    setError(null);
    transport
      .decidePending(id, itemId, decision)
      .then((next) => setMemory(next))
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(null));
  };

  let chat = null;
  if (asleep) {
    chat = (
      <div className="ph-comp-asleep">
        {abilities.canControl && (
          <button type="button" className="ph-btn ph-btn--primary ph-comp-wide" disabled={busy !== null} onClick={() => toggleAgent('wake')}>
            {`Wake up ${name}`}
          </button>
        )}
      </div>
    );
  } else if (!paneId) {
    chat = state === 'starting' ? <div className="ph-loading">Waking up…</div> : null;
  } else if (!chatAllowed) {
    chat = <p className="ph-comp-note">Chat can&apos;t send messages to this agent yet.</p>;
  } else {
    chat = (
      <PhoneChatView key={paneId} bridge={bridge} paneId={paneId} canWatch={abilities.canWatch} canType={abilities.canType} companion />
    );
  }

  return (
    <div className="ph-comp">
      <div className="ph-comp-top">
        <header className="ph-comp-head">
          {abilities.canControl && !asleep && (
            <div className="ph-home-menu">
              <button ref={menuBtn} type="button" className="ph-home-menu-btn" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} data-testid="companion-menu" onClick={() => setMenuOpen((open) => !open)}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
              {menuOpen && (
                <Menu anchorRef={menuBtn} align="end" className="ph-home-menu-list" label="More" testId="companion-menu-list" onClose={() => setMenuOpen(false)}>
                  <button type="button" role="menuitem" disabled={busy !== null} onClick={() => toggleAgent('sleep')}>
                    Sleep
                  </button>
                </Menu>
              )}
            </div>
          )}
          <Avatar id={companion.avatar} size={HOME_FACE_PX} state={state} name={name} />
          <h1 className="ph-comp-name">{name}</h1>
          <p className="ph-comp-state">{companion.stateLine}</p>
          <p className="ph-comp-agent">
            On {companion.agentLabel}
            {companion.untilMs ? ` until ${clockLabel(companion.untilMs)}` : ''}
          </p>
          {nextCheckin && <p className="ph-comp-agent ph-comp-next">{`Next: ${nextCheckin.label} · ${clockLabel(nextCheckin.atMs)}`}</p>}
          {needs && (
            <button type="button" className="ph-btn ph-btn--primary ph-comp-wide" onClick={() => onOpenCard(needs.itemId)}>
              Open card
            </button>
          )}
        </header>
        <CompanionFeed items={feed} expanded={feedOpen} onToggle={() => setFeedOpen((open) => !open)} />
        <CompanionPending
          name={name}
          items={memory?.pending ?? []}
          canAnswer={abilities.canAnswer}
          busyId={busy}
          onDecide={decide}
        />
        <CompanionSkills name={name} skills={memory?.skills ?? []} />
        {error && (
          <p className="ph-comp-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ph-comp-chat">{chat}</div>
    </div>
  );
}
