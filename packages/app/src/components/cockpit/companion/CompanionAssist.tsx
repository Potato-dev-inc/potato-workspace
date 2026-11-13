// Everything the companion does outside its own page, mounted once in the cockpit:
//  - speaks first, with a quiet budget (proposal 17): the bubble and the one-time offer;
//  - "check on this one" (proposal 37): Potato dropped on an agent (or chosen from its row menu), then Watch / Nudge / Thanks.
// Only one bubble shows at a time: a check the person asked for first, then a watch that fired, then speak-first, then the offer.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCompanionSpeak } from '../../../hooks/useCompanionSpeak';
import type { NeedsYouItem } from '../../../lib/attention';
import type { CompanionView } from '../../../lib/companion';
import { setSpeak, useSpeakSettings, type SpeakEvent } from '../../../lib/companionSpeak';
import { onPotatoCheckRequest, watchChange, watchStateOf, type WatchState } from '../../../lib/potatoCheck';
import type { SideQuestionApi } from '../../../lib/sideQuestion';
import { useUsage, usageApi } from '../../../lib/usage';
import { useT } from '../../../i18n';
import { CompanionBubble, rowSelector, useAnchor } from './CompanionBubble';
import { PotatoCheck } from './PotatoCheck';
import { PotatoDropZones } from './PotatoDropZones';
import { SpeakBubble, SpeakOffer } from './SpeakBubble';

/** How long the app is open before the one quiet offer appears. */
export const OFFER_DELAY_MS = 4_000;

export interface CompanionAssistProps {
  /** The companion that speaks: the first one. Null: no companion, nothing here shows. */
  companion: CompanionView | null;
  needsYou: readonly NeedsYouItem[];
  panes: ReadonlyArray<{ id: string; status: string }>;
  nameOf: (paneId: string) => string;
  activityOf: (paneId: string) => string | null;
  onOpenPane: (paneId: string) => void;
  onOpenInbox: () => void;
  /** Sends the short "status?" message into the pane. Called only after a click on "Nudge it". */
  onNudge: (paneId: string) => void;
  api?: SideQuestionApi;
}

interface WatchNote {
  paneId: string;
  change: 'needs' | 'done' | 'working';
}

export function CompanionAssist({ companion, needsYou, panes, nameOf, activityOf, onOpenPane, onOpenInbox, onNudge, api }: CompanionAssistProps) {
  const [settings] = useSpeakSettings();
  const [checkPane, setCheckPane] = useState<string | null>(null);
  const [watchNote, setWatchNote] = useState<WatchNote | null>(null);
  const watches = useRef(new Map<string, WatchState>());
  const [offerReady, setOfferReady] = useState(false);

  const { snap } = useUsage(usageApi, settings.on, false);
  const speak = useCompanionSpeak({ settings, companion, needsYou, panes, nameOf, usageRows: snap?.rows });

  const startCheck = useCallback((paneId: string) => setCheckPane(paneId), []);
  useEffect(() => onPotatoCheckRequest(startCheck), [startCheck]);

  // The one quiet offer, a few seconds after the app opened, until the person answers it.
  const offerWanted = !!companion && !settings.offered && !settings.on;
  useEffect(() => {
    if (!offerWanted) {
      setOfferReady(false);
      return undefined;
    }
    const id = setTimeout(() => setOfferReady(true), OFFER_DELAY_MS);
    return () => clearTimeout(id);
  }, [offerWanted]);

  // Watches: one change, one bubble, and the watch ends.
  useEffect(() => {
    if (watches.current.size === 0) return;
    for (const [paneId, was] of [...watches.current]) {
      const pane = panes.find((p) => p.id === paneId);
      if (!pane) {
        watches.current.delete(paneId);
        continue;
      }
      const asking = needsYou.some((n) => n.paneId === paneId);
      const change = watchChange(was, watchStateOf(pane.status, asking));
      if (change) {
        watches.current.delete(paneId);
        setWatchNote({ paneId, change });
      }
    }
  }, [panes, needsYou]);

  const closeCheck = useCallback(() => setCheckPane(null), []);

  if (!companion) return <PotatoDropZones onDropOn={startCheck} />;

  const openFor = (e: SpeakEvent) => {
    speak.open();
    if (e.paneId) onOpenPane(e.paneId);
    else onOpenInbox();
  };

  let bubble = null;
  if (checkPane) {
    const pane = panes.find((p) => p.id === checkPane);
    bubble = (
      <PotatoCheck
        key={checkPane}
        companionName={companion.name}
        target={{ paneId: checkPane, agent: nameOf(checkPane), status: pane?.status ?? 'idle', needsYou: needsYou.some((n) => n.paneId === checkPane), activity: activityOf(checkPane) }}
        anchorSelector={rowSelector(checkPane)}
        api={api}
        onWatch={() => watches.current.set(checkPane, watchStateOf(pane?.status ?? 'idle', needsYou.some((n) => n.paneId === checkPane)))}
        onNudge={() => onNudge(checkPane)}
        onClose={closeCheck}
      />
    );
  } else if (watchNote) {
    bubble = <WatchBubble note={watchNote} agent={nameOf(watchNote.paneId)} companionName={companion.name} onOpen={() => { onOpenPane(watchNote.paneId); setWatchNote(null); }} onClose={() => setWatchNote(null)} />;
  } else if (speak.event) {
    bubble = <SpeakBubble event={speak.event} companionName={companion.name} onOpen={() => openFor(speak.event!)} onLater={speak.later} onTooMuch={speak.tooMuch} />;
  } else if (offerWanted && offerReady) {
    bubble = <SpeakOffer companionName={companion.name} onYes={() => setSpeak({ on: true, offered: true })} onNo={() => setSpeak({ offered: true })} />;
  }
  return (
    <>
      <PotatoDropZones onDropOn={startCheck} />
      {bubble}
    </>
  );
}

function WatchBubble({ note, agent, companionName, onOpen, onClose }: { note: WatchNote; agent: string; companionName: string; onOpen: () => void; onClose: () => void }) {
  const t = useT();
  const anchor = useAnchor(rowSelector(note.paneId), note.change);
  return (
    <CompanionBubble face={note.change === 'needs' ? 'needs-you' : note.change === 'done' ? 'celebrate' : 'working'} label={t('companion.speak.region', { name: companionName })} anchor={anchor} onClose={onClose} testId="watch-bubble">
      <p className="ck-pbubble-line">{t(`potato.watch.${note.change}`, { agent })}</p>
      <div className="ck-pbubble-actions">
        <button type="button" className="ck-btn ck-btn--tiny ck-btn--primary" onClick={onOpen}>
          {t('companion.speak.open')}
        </button>
        <button type="button" className="ck-btn ck-btn--tiny ck-btn--plain" onClick={onClose}>
          {t('potato.check.thanks')}
        </button>
      </div>
    </CompanionBubble>
  );
}
