// Find in this chat: what the open chat is looking for, shared with the folded rows so a row that holds a match
// opens by itself. The marks and the count are drawn from the page text (useChatFind), not from this file.
import { createContext, useContext } from 'react';
import type { ToolStep } from '../../lib/sessionChatModel';

/** The text being looked for ('' when the find box is closed or empty). */
export const ChatFindContext = createContext<string>('');

export function useFindQuery(): string {
  return useContext(ChatFindContext);
}

/** Everything a tool row holds in its open part: the input, the files and the output. */
export function stepDetailText(step: ToolStep): string {
  let input = '';
  try {
    input = step.call.input === undefined ? '' : (JSON.stringify(step.call.input) ?? '');
  } catch {
    input = '';
  }
  return `${input}\n${step.call.paths?.join('\n') ?? ''}\n${step.result?.output ?? ''}`;
}

/** Whether `text` holds `query` (case does not matter). A query of one letter opens nothing: it would open every row. */
export function holdsQuery(text: string, query: string): boolean {
  return query.trim().length >= 2 && text.toLowerCase().includes(query.toLowerCase());
}

/** A tool row opens by itself when its detail holds the match. */
export function useStepFindsOpen(step: ToolStep): boolean {
  return holdsQuery(stepDetailText(step), useFindQuery());
}

/** A folded line of rows opens by itself when any of its rows holds the match (even in the row's own title). */
export function useStepsFindOpen(steps: readonly ToolStep[]): boolean {
  const query = useFindQuery();
  if (query === '') return false;
  return steps.some((step) => holdsQuery(`${step.call.name}\n${step.call.summary}\n${stepDetailText(step)}`, query));
}
