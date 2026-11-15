// Reading an invite LINK (not the older pasted invite text). A link comes from outside, so it is untrusted:
// from it we take only a code and a host name, strictly. Everything else (team name, who invited) is asked of
// the Worker. The same rules as src-tauri/src/team/invite_web.rs `parse_target`, which checks again.

export interface JoinLink {
  /** 16 letters and digits, upper case. */
  code: string;
  /** The Worker's host name, lower case, no scheme, no port. */
  host: string;
}

// Same alphabet as the Worker: no 0/O, 1/I/L, U.
const CODE = /^[2-9A-HJKMNP-TV-Z]{16}$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** A public DNS name only: not an IP address, not localhost, no port, no user name. */
export function isPublicHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  const lower = host.toLowerCase();
  if (lower === 'localhost' || /\.(localhost|local|internal)$/.test(lower)) return false;
  const labels = lower.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

const DEEP = 'potato-workspace://join/';

/** `https://<host>/join/<code>` or `potato-workspace://join/<code>?w=<host>`; anything else is null. */
export function parseJoinLink(text: string): JoinLink | null {
  const link = text.trim();
  if (!link || link.length > 512 || /[\s\u0000-\u001f\u007f]/.test(link)) return null;
  let code: string;
  let host: string;
  if (link.startsWith(DEEP)) {
    const rest = link.slice(DEEP.length);
    const at = rest.indexOf('?');
    if (at < 0) return null;
    code = rest.slice(0, at).replace(/\/+$/, '');
    const pairs = rest.slice(at + 1).split('&');
    // Exactly one `w=` and nothing else: extra parts are refused, not ignored.
    if (pairs.length !== 1 || !pairs[0].startsWith('w=')) return null;
    host = pairs[0].slice(2);
  } else if (link.startsWith('https://')) {
    const rest = link.slice('https://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    host = rest.slice(0, slash);
    const path = rest.slice(slash + 1);
    if (!path.startsWith('join/')) return null;
    code = path.slice('join/'.length).replace(/\/+$/, '');
  } else {
    return null;
  }
  code = code.toUpperCase();
  if (!CODE.test(code) || !isPublicHost(host)) return null;
  return { code, host: host.toLowerCase() };
}

/** The first invite link inside pasted text ("Join my team: https://… ."), or null. */
export function findJoinLink(text: string): { text: string; link: JoinLink } | null {
  const found = /(?:https:\/\/[^\s"'<>]+\/join\/[^\s"'<>]+|potato-workspace:\/\/join\/[^\s"'<>]+)/i.exec(text);
  if (!found) return null;
  const clean = found[0].replace(/[.,;:!?)\]]+$/, '');
  const link = parseJoinLink(clean);
  return link ? { text: clean, link } : null;
}

/** The link in the form the Rust commands take. */
export const joinLinkText = (l: JoinLink): string => `https://${l.host}/join/${l.code}`;

/** The window event a delivered deep link is announced with (the shell turns the OS link into this). */
export const JOIN_LINK_EVENT = 'pm:join-link';
