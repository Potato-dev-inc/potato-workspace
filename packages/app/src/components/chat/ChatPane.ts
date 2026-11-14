// Which pane a chat belongs to, for the pieces deep inside it (a file chip in a tool card) that need to act on the
// pane's project: "Open in editor" on a file name.
import { createContext, useContext } from 'react';

export const ChatPaneContext = createContext<string | null>(null);

export function useChatPane(): string | null {
  return useContext(ChatPaneContext);
}
