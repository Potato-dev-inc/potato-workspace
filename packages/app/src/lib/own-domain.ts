// "My domain": what a person types for their own web address, turned into one https origin (the same rules as
// src-tauri/src/own_domain.rs, which is the authority; this only gives the answer while typing). Errors are i18n keys.
import type { MessageKey } from '../i18n';

export type OwnDomainResult = { ok: true; url: string } | { ok: false; error: MessageKey };

const bad = (error: MessageKey): OwnDomainResult => ({ ok: false, error });
const PRIVATE_SUFFIX = ['.local', '.localhost', '.internal', '.lan', '.home', '.home.arpa', '.corp'];

export function normalizeOwnDomain(raw: string): OwnDomainResult {
  const typed = raw.trim();
  if (!typed) return bad('connect.domain.err.empty');
  const sep = typed.indexOf('://');
  const scheme = sep >= 0 ? typed.slice(0, sep).toLowerCase() : 'https';
  const rest = sep >= 0 ? typed.slice(sep + 3) : typed;
  if (scheme !== 'https' && scheme !== 'http') return bad('connect.domain.err.scheme');
  const authority = (rest.split(/[/?#]/)[0] ?? '').toLowerCase();
  if (!authority || /[@\s*\\]/.test(authority)) return bad('connect.domain.err.shape');
  if (authority.startsWith('[')) return bad('connect.domain.err.ip');
  let host = authority;
  let port: number | null = null;
  const colon = authority.lastIndexOf(':');
  if (colon >= 0) {
    const p = authority.slice(colon + 1);
    if (!/^\d+$/.test(p)) return bad('connect.domain.err.shape');
    port = Number(p);
    if (port < 1 || port > 65535) return bad('connect.domain.err.port');
    host = authority.slice(0, colon);
  }
  host = host.replace(/\.+$/, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return bad('connect.domain.err.shape');
  if (/^[0-9.]+$/.test(host)) return bad('connect.domain.err.ip');
  {
    // This computer is never "my domain" (a phone cannot reach it).
    if (host === 'localhost' || host.endsWith('.localhost')) return bad('connect.domain.err.local');
    if (scheme === 'http') return bad('connect.domain.err.http');
    // Old-style number spellings (0x7f.1, 127.1, example.123) are read as numbers by some systems.
    const last = host.slice(host.lastIndexOf('.') + 1);
    if (/^\d+$/.test(last) || last.startsWith('0x')) return bad('connect.domain.err.ip');
    if (host.endsWith('.trycloudflare.com') || host.endsWith('.workers.dev')) return bad('connect.domain.err.cloudflare');
    if (!host.includes('.') || PRIVATE_SUFFIX.some((s) => host.endsWith(s))) return bad('connect.domain.err.full');
    if (host.length > 253 || host.split('.').some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return bad('connect.domain.err.shape');
  }
  const defaultPort = scheme === 'https' ? 443 : 80;
  return { ok: true, url: port !== null && port !== defaultPort ? `${scheme}://${host}:${port}` : `${scheme}://${host}` };
}

export type PhonePortResult = { ok: true; port: number | null } | { ok: false; error: MessageKey };

/** "Port on this PC": empty means automatic; otherwise a whole number from 1024 to 65535 (Rust checks again and is the authority). */
export function parsePhonePort(raw: string): PhonePortResult {
  const typed = raw.trim();
  if (!typed) return { ok: true, port: null };
  if (!/^\d{1,6}$/.test(typed)) return { ok: false, error: 'connect.domain.err.phonePort' };
  const port = Number(typed);
  if (port < 1024 || port > 65535) return { ok: false, error: 'connect.domain.err.phonePort' };
  return { ok: true, port };
}
