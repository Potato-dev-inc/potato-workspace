// The message box of a chat that runs on another PC: the same `OutboxTransport` the desktop's own chat box takes, over the PC link
// (`/pclink/sessions/:id/messages`). Sending and cancelling are Answer-level routes: the far PC refuses a PC that may only watch,
// and the sentence says so. Holding and editing a queued message are not routes of the PC link (a message goes to the far agent
// when it is ready, or it is cancelled), so they say that in one plain sentence.
import { t } from '../../i18n';
import { errorSentence } from '../sayError';
import type { OutboxMessage, OutboxTransport } from '../paneOutbox';
import { pollWithBackoff } from './pollWithBackoff';
import { PcLinkError, type PcLinkClient } from './pclink';

/** How often the far PC's list is read while the box is on screen (an `outbox` event also asks for it sooner). */
export const PC_OUTBOX_POLL_MS = 5000;

/** The plain sentence of a failed call: the far PC's own words, or one of ours. */
export function pcRefusalText(error: unknown, fallback: string): string {
  if (error instanceof PcLinkError) {
    // "Messaging it needs Full": the far PC's own sentence says what to change; the general refusal would hide it.
    if (error.status === 403) return error.code === 'MESSAGE_NEEDS_FULL' && error.said ? error.said : t('pclink.notAllowed');
    return error.said ?? fallback;
  }
  return errorSentence(error) ? t('pclink.unreachable') : fallback;
}

type Watcher = (messages: OutboxMessage[]) => void;
const watchers = new Map<string, Set<Watcher>>();

/** An `outbox` event came in from a far PC: the boxes that watch this session read again. */
export function publishPcOutbox(node: string, id: string, messages: OutboxMessage[]): void {
  for (const notify of [...(watchers.get(`${node}:${id}`) ?? [])]) notify(messages);
}

export function pcLinkOutboxTransport(client: PcLinkClient): OutboxTransport {
  const key = (id: string) => `${client.node}:${id}`;
  const list = (id: string): Promise<OutboxMessage[]> => client.messages(id);
  return {
    async send(id, text) {
      try {
        return await client.sendMessage(id, text);
      } catch (error) {
        throw new Error(pcRefusalText(error, t('pclink.sendFailed')));
      }
    },
    async cancel(id, messageId) {
      try {
        return await client.cancelMessage(id, messageId);
      } catch (error) {
        throw new Error(pcRefusalText(error, t('pclink.cancelFailed')));
      }
    },
    async hold() {
      throw new Error(t('pclink.noEdit'));
    },
    async edit() {
      throw new Error(t('pclink.noEdit'));
    },
    list,
    watch(id, cb) {
      let live = true;
      const notify: Watcher = (messages) => {
        if (live) cb(messages);
      };
      const set = watchers.get(key(id)) ?? new Set<Watcher>();
      set.add(notify);
      watchers.set(key(id), set);
      const stopPoll = pollWithBackoff({
        node: client.node,
        route: `messages:${id}`,
        normalMs: PC_OUTBOX_POLL_MS,
        immediate: false,
        run: async () => notify(await list(id)),
      });
      return () => {
        live = false;
        stopPoll();
        const current = watchers.get(key(id));
        current?.delete(notify);
        if (current && current.size === 0) watchers.delete(key(id));
      };
    },
  };
}
