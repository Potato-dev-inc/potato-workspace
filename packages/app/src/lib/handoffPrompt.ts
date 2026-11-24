// The first words of the message Hand off sends to the agent (`quickWritePrompt`, `fileWritePrompt` in handoff.ts). The chat folds such
// a message behind "Handoff instructions": it is the app's own long brief, not something the person typed.
export const HANDOFF_PROMPT_START = 'Please write a handoff for the next agent';

export const isHandoffPrompt = (text: string): boolean => text.startsWith(HANDOFF_PROMPT_START);
