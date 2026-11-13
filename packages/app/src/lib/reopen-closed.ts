// Ctrl+Shift+T: reopens the chat that was closed last, like a browser tab. "Last" is the newest by its own last
// activity. The chats stay on disk, so nothing is lost; with none closed it says so in one plain line.
import { t } from '../i18n';
import { type ClosedChat, type ClosedChatsApi, tauriClosedChatsApi } from './closedChats';
import { errorSentence } from './sayError';

/** Ctrl+Shift+T (Cmd+Shift+T on a Mac). */
export function isReopenChatKey(e: KeyboardEvent, mac: boolean): boolean {
  const main = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return main && e.shiftKey && !e.altKey && e.key.toLowerCase() === 't';
}

export function lastClosed(chats: readonly ClosedChat[]): ClosedChat | null {
  let best: ClosedChat | null = null;
  for (const chat of chats) if (!best || chat.updated_ms > best.updated_ms) best = chat;
  return best;
}

export async function reopenLastClosedChat(
  select: (paneId: string) => void,
  notify: (text: string) => void,
  api: Pick<ClosedChatsApi, 'list' | 'reopen'> = tauriClosedChatsApi,
): Promise<void> {
  try {
    const chat = lastClosed(await api.list());
    if (!chat) {
      notify(t('undo.noClosed'));
      return;
    }
    const paneId = await api.reopen(chat.id);
    select(paneId);
    notify(t('undo.reopened', { name: chat.title?.trim() || chat.label }));
  } catch (err) {
    notify(errorSentence(err));
  }
}
