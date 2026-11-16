// Reads the clipboard for a "Paste link" / "Paste token" button: the text, trimmed. Throws when the window may not
// read the clipboard (the caller shows the plain "cannot read" sentence instead).
export async function readClipboardText(): Promise<string> {
  const text = await navigator.clipboard.readText();
  return (text ?? '').trim();
}
