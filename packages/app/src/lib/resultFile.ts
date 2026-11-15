// "Files come back": a result file of a remote chat.
//
// Convention: an agent on the far PC names a result file by ending its reply with one line, exactly
//   potato-result: <relative/path>
// (a path inside the chat's folder, with `/`). Only the LAST assistant message is looked at, and only a line that is
// exactly that. The path is checked here for shape only; the far device checks it again after resolving links.
// TODO: add this instruction to the remote prompt later (not part of the files task).
const PREFIX = 'potato-result:';
const MAX = 400;

/** One relative path with `/`: no drive letter, no leading `/`, no backslash, no `..`, no control characters. */
export function safeRelativePath(raw: string): string | null {
  const p = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (p === '' || p.length > MAX || /[\\\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  if (p.split('/').some((x) => x === '' || x === '..' || x === '.')) return null;
  return p;
}

/** The result path of a chat, or null. `items` is what `GET /panes/<id>/chat` answers (untrusted). */
export function resultFileOf(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  let last: string | null = null;
  for (const it of items) {
    const x = it as { kind?: unknown; text?: unknown } | null;
    if (x && x.kind === 'assistant' && typeof x.text === 'string') last = x.text;
  }
  if (last === null) return null;
  const lines = last.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith(PREFIX)) return safeRelativePath(line.slice(PREFIX.length));
  }
  return null;
}
