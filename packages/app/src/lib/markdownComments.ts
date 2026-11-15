// Hides HTML comments (`<!-- ... -->`) from a Markdown file before it is drawn as a page, like GitHub does. Comments
// inside a fenced code block or inline code stay: they are code, not comments. The "Show as text" view never calls this.

/** The text without its HTML comments. A comment that is not closed hides the rest of the file, like a browser does. */
export function stripHtmlComments(text: string): string {
  if (!text.includes('<!--')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let open = false;
  for (const line of lines) {
    if (!open) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        out.push(line);
        continue;
      }
      if (f) {
        fence = f[1];
        out.push(line);
        continue;
      }
    }
    const kept = cutComments(line, open);
    open = kept.open;
    // A line that held only a comment leaves nothing behind, not an empty line that would split a list.
    if (kept.text.trim() === '' && line.trim() !== '') continue;
    out.push(kept.text);
  }
  return out.join('\n');
}

function cutComments(line: string, startOpen: boolean): { text: string; open: boolean } {
  let res = '';
  let i = 0;
  let open = startOpen;
  while (i < line.length) {
    if (open) {
      const end = line.indexOf('-->', i);
      if (end < 0) return { text: res, open: true };
      i = end + 3;
      open = false;
      continue;
    }
    const tick = line[i] === '`' ? /^`+/.exec(line.slice(i))?.[0] : undefined;
    if (tick) {
      const close = line.indexOf(tick, i + tick.length);
      if (close >= 0) {
        res += line.slice(i, close + tick.length);
        i = close + tick.length;
        continue;
      }
    }
    if (line.startsWith('<!--', i)) {
      open = true;
      i += 4;
      continue;
    }
    res += line[i];
    i += 1;
  }
  return { text: res, open };
}
