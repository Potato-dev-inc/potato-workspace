import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  spaceFileGet, spaceFileOffer, spaceFileSave, spacesErrorText, useChannel, type SpaceChannel, type SpaceMessage,
} from '../../lib/spaces';
import { MessageRow } from './MessageRow';
import { Composer } from './Composer';

export interface ChannelViewProps {
  space: string;
  channel: SpaceChannel;
  menu?: (m: SpaceMessage, reply: () => void) => ReactNode;
  onReact?: (m: SpaceMessage, code: string, on: boolean) => void;
  /** A space I left or was removed from: the feed stays, the composer goes. */
  readOnly?: boolean;
}

export function ChannelView({ space, channel, menu, onReact, readOnly }: ChannelViewProps) {
  const ch = useChannel(space, channel.id);
  const [replyTo, setReplyTo] = useState<SpaceMessage | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [fileErrors, setFileErrors] = useState<Record<string, string | null>>({});
  const [savedAs, setSavedAs] = useState<Record<string, string>>({});
  const end = useRef<HTMLDivElement>(null);
  const getFile = (m: SpaceMessage) => {
    if (!m.file) return;
    setFileErrors((e) => ({ ...e, [m.id]: null }));
    spaceFileGet(space, m.file.sha).catch((e: unknown) => setFileErrors((x) => ({ ...x, [m.id]: spacesErrorText(e) })));
  };
  const saveFile = (m: SpaceMessage) => {
    if (!m.file) return;
    setFileErrors((e) => ({ ...e, [m.id]: null }));
    spaceFileSave(space, m.file.sha).then(
      (r) => setSavedAs((s) => ({ ...s, [m.id]: r.name })),
      (e: unknown) => setFileErrors((x) => ({ ...x, [m.id]: spacesErrorText(e) })),
    );
  };
  const attach = async (path: string): Promise<string | null> => {
    try {
      await spaceFileOffer(space, channel.id, path);
      return null;
    } catch (e) {
      return spacesErrorText(e);
    }
  };
  const lastId = ch.messages[ch.messages.length - 1]?.id;
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [lastId]);
  return (
    <section className="ck-spaces-feed" aria-label={`#${channel.name}`}>
      <h2 className="ck-spaces-feed-title"># {channel.name}</h2>
      <ol className="ck-spaces-msgs">
        {ch.atStart ? (
          <li className="ck-spaces-start">This is the start of #{channel.name}.</li>
        ) : (
          <li><button type="button" className="ck-spaces-link" onClick={() => void ch.loadOlder()}>Show older messages</button></li>
        )}
        {ch.messages.map((m) => (
          <MessageRow key={m.id} message={m} onReply={setReplyTo} menu={menu} onReact={onReact}
            fileError={fileErrors[m.id] ?? null} fileSavedAs={savedAs[m.id] ?? null} onGetFile={getFile} onSaveFile={saveFile}
            revealBlocked={revealed.has(m.id)} onRevealBlocked={() => setRevealed(new Set(revealed).add(m.id))} />
        ))}
      </ol>
      <div ref={end} />
      {ch.error && <p className="ck-spaces-hint is-error" role="alert">{ch.error}</p>}
      {!readOnly && (
        <Composer channelName={channel.name} replyTo={replyTo} onCancelReply={() => setReplyTo(null)}
          disabled={channel.archived} onAttach={attach} onSend={(text) => ch.send(text, replyTo?.id ?? null)} />
      )}
    </section>
  );
}
