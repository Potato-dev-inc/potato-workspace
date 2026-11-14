// The message box of one pane's Chat tab: the pane's waiting and just-finished messages (the list from the
// transport, then its change events), and the two things a person does: send and cancel. The transport is the
// desktop's Tauri commands or the phone's bridge (lib/paneOutbox.ts, lib/paneOutbox-bridge.ts).
import { errorSentence } from '../lib/sayError';
import { useCallback, useEffect, useState } from 'react';
import { withSent, type OutboxMessage, type OutboxTransport } from '../lib/paneOutbox';
import type { ChatAttachment } from '../lib/attachFiles';

const SEND_FAILED = 'Could not send the message.';

export interface PaneOutboxHook {
  messages: OutboxMessage[];
  /** Sends a message. Resolves to null, or to one plain sentence saying why it was not accepted. */
  send: (text: string, attachments?: readonly ChatAttachment[]) => Promise<string | null>;
  /** Cancels a waiting message. Resolves to null, or to the reason it could not be cancelled. */
  cancel: (messageId: string) => Promise<string | null>;
  /** Keeps a waiting message back while it is edited (`hold` true), or lets it go on. Resolves to null, or the reason. */
  hold: (messageId: string, hold: boolean) => Promise<string | null>;
  /** Saves new text for a waiting message, in the same place. Resolves to null, or the reason. */
  edit: (messageId: string, text: string) => Promise<string | null>;
}

const NOT_CONNECTED = 'Could not reach your PC.';

/**
 * `showSending`: a message shows as "sending" from the moment it is sent until the PC answers (the phone wants that:
 * the link can be slow). It goes away when the PC's own copy arrives, or when the send is refused or fails.
 */
export function usePaneOutbox(transport: OutboxTransport | null, paneId: string, enabled: boolean, showSending = false): PaneOutboxHook {
  const [messages, setMessages] = useState<OutboxMessage[]>([]);
  const [local, setLocal] = useState<OutboxMessage | null>(null);

  useEffect(() => {
    if (!enabled || !transport) return;
    let live = true;
    setMessages([]);
    // Watch before listing, so a change that happens while the list is in flight is not lost.
    const stop = transport.watch(paneId, (list) => {
      if (live) setMessages(list);
    });
    transport
      .list(paneId)
      .then((list) => {
        // An event that came first is newer than this list.
        if (live) setMessages((prev) => (prev.length > 0 ? prev : list));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [transport, paneId, enabled]);

  const send = useCallback(
    async (text: string, attachments?: readonly ChatAttachment[]) => {
      if (!transport) return NOT_CONNECTED;
      if (showSending) setLocal({ id: `local-${Date.now()}`, text, createdAt: Date.now(), state: 'sending', waitingFor: null, error: null });
      try {
        const sent = await transport.send(paneId, text, attachments);
        setMessages((prev) => withSent(prev, sent));
        return null;
      } catch (error) {
        return errorSentence(error, SEND_FAILED);
      } finally {
        if (showSending) setLocal(null);
      }
    },
    [transport, paneId, showSending],
  );

  const cancel = useCallback(
    async (messageId: string) => {
      if (!transport) return NOT_CONNECTED;
      try {
        const done = await transport.cancel(paneId, messageId);
        setMessages((prev) => prev.map((m) => (m.id === done.id ? done : m)));
        return null;
      } catch (error) {
        return errorSentence(error, SEND_FAILED);
      }
    },
    [transport, paneId],
  );

  const replace = useCallback(
    async (change: () => Promise<OutboxMessage>) => {
      try {
        const done = await change();
        setMessages((prev) => prev.map((m) => (m.id === done.id ? done : m)));
        return null;
      } catch (error) {
        return errorSentence(error, SEND_FAILED);
      }
    },
    [],
  );

  const hold = useCallback(
    async (messageId: string, on: boolean) => (transport ? replace(() => transport.hold(paneId, messageId, on)) : NOT_CONNECTED),
    [transport, paneId, replace],
  );

  const edit = useCallback(
    async (messageId: string, text: string) => (transport ? replace(() => transport.edit(paneId, messageId, text)) : NOT_CONNECTED),
    [transport, paneId, replace],
  );

  return { messages: local ? [...messages, local] : messages, send, cancel, hold, edit };
}
