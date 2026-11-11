// Reading a pasted invite. People paste the whole message ("Join my team: pm://team/join?… code KQ7M-4XPD"),
// so the link and the code are picked out of any text around them. Pure, so it is tested without a page.

/** What was found in pasted text. `link` and `code` are each null when the text has none. */
export interface PastedInvite {
  link: string | null;
  code: string | null;
}

const LINK = /pm:\/\/team\/join\?[^\s"'<>]+/i;
// The code alphabet leaves out 0, 1, I, L, O and U (see src-tauri/src/team/invite.rs), so ordinary words rarely match.
const CODE_ALPHABET = 'A-HJ-NP-TV-Z2-9';
const DASHED_CODE = new RegExp(`(?<![A-Z0-9])([${CODE_ALPHABET}]{4})[-\s]([${CODE_ALPHABET}]{4})(?![A-Z0-9])`, 'i');
const LABELLED_CODE = new RegExp(`code(?:\\s+is)?\\W{0,4}([${CODE_ALPHABET}]{4})[-\\s]?([${CODE_ALPHABET}]{4})(?![A-Z0-9])`, 'i');

/** "abcd efgh" or "abcdefgh" -> "ABCD-EFGH" (letters and digits only, 8 at most). */
export function formatCode(text: string): string {
  const raw = text
    .replace(/[^a-z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** Find the invite link and, when it is there too, the one-time code in text that was pasted. */
export function parsePastedInvite(text: string): PastedInvite {
  const found = LINK.exec(text);
  // A full stop or bracket right after the link belongs to the sentence, not to the link.
  const link = found ? found[0].replace(/[.,;:!?)\]]+$/, '') : null;
  const rest = found ? text.replace(found[0], ' ') : text;
  const code = LABELLED_CODE.exec(rest) ?? DASHED_CODE.exec(rest);
  return { link, code: code ? formatCode(`${code[1]}${code[2]}`) : null };
}
