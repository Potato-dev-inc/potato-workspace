// How a card inside the chat sends the person's answer back: as an ordinary message of this chat. The desktop panel and
// the phone each provide the function that sends (the same outbox the message box uses). No provider: the card is read-only.
import { createContext, useContext } from 'react';

export type AnswerSender = (text: string) => Promise<string | null>;

export const ChatAnswerContext = createContext<AnswerSender | null>(null);

export function useChatAnswer(): AnswerSender | null {
  return useContext(ChatAnswerContext);
}
