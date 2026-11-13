// The quoted block "Tell the agent" puts into the chat box: where the lines are, the lines, then the person's note.
export function tellText(path: string, from: number, to: number, code: string, note: string, fence = ''): string {
  const where = from === to ? `\`${path}\` line ${from}` : `\`${path}\` lines ${from}-${to}`;
  const body = code.replace(/\n+$/, '');
  const quote = ['```' + fence, body, '```'].join('\n');
  const tail = note.trim();
  return tail ? `${where}:\n${quote}\n${tail}` : `${where}:\n${quote}\n`;
}
