// Invite links: https://<worker>/join/<one-time-code>.
//
// The inviter's app (a signed team request) leaves a small record here: what to show (team name, who
// invited) and an opaque payload the joiner's app needs (the invite link and code of the existing
// invite, see packages/app/src-tauri/src/team/invite.rs). The record lives in its own Durable Object, named
// by the hash of the code, and:
//   - is read twice by the joiner: `peek` (what to show; never burns) and `claim` (the payload; burns);
//   - burns on the FIRST claim, inside the object, so two claims racing give one winner;
//   - expires after 24 hours at most, and is wiped by an alarm.
// A browser preview or a chat app opening the link only ever does a GET, which never burns it. The
// inviter still approves every join in the app: this link only carries the invite to the joiner.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export const CODE_LEN = 16;
/** No 0/O, 1/I/L, U: a code read aloud or typed cannot be mistyped. 30 symbols x 16 = about 78 bits. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_TTL_MS = 60 * 1000;
export const MAX_PAYLOAD_BYTES = 4096;
const MAX_LABEL = 60;
/** How long the "used" mark stays after expiry, so a used link says "used", not "unknown". */
const GRACE_MS = 60 * 60 * 1000;

export const isCode = (text: string): boolean => /^[2-9A-HJKMNP-TV-Z]{16}$/.test(text);

/** A fresh random code. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** The Durable Object's name for a code: its hash, so the code itself is never a name. */
export async function codeKey(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pm-invite-link-v1\0${code}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A name for display: no control characters, trimmed, capped. */
export function label(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}

export interface InviteRecord {
  team: string;
  team_name: string;
  inviter: string;
  payload: string;
  expires_at_ms: number;
  claimed_at_ms: number | null;
}

export type Peek =
  | { state: "open"; team_name: string; inviter: string; expires_at_ms: number }
  | { state: "used" | "expired" | "unknown" };
export type Claim =
  | { state: "claimed"; team_name: string; inviter: string; payload: string }
  | { state: "used" | "expired" | "unknown" };

export class InviteBox extends DurableObject<Env> {
  async put(record: Omit<InviteRecord, "claimed_at_ms">): Promise<boolean> {
    if (await this.ctx.storage.get("rec")) return false; // a code is never reused
    await this.ctx.storage.put("rec", { ...record, claimed_at_ms: null } satisfies InviteRecord);
    await this.ctx.storage.setAlarm(record.expires_at_ms + GRACE_MS);
    return true;
  }

  private async read(): Promise<{ rec: InviteRecord; state: "open" | "used" | "expired" } | null> {
    const rec = await this.ctx.storage.get<InviteRecord>("rec");
    if (!rec) return null;
    if (rec.claimed_at_ms !== null) return { rec, state: "used" };
    return { rec, state: rec.expires_at_ms <= Date.now() ? "expired" : "open" };
  }

  /** What the app shows before the person says yes. Never burns. */
  async peek(): Promise<Peek> {
    const found = await this.read();
    if (!found) return { state: "unknown" };
    if (found.state !== "open") return { state: found.state };
    return { state: "open", team_name: found.rec.team_name, inviter: found.rec.inviter, expires_at_ms: found.rec.expires_at_ms };
  }

  /**
   * The payload, once. A Durable Object runs one call at a time and there is no await between the read and
   * the write below, so two claims at the same moment cannot both win.
   */
  async claim(): Promise<Claim> {
    const found = await this.read();
    if (!found) return { state: "unknown" };
    if (found.state !== "open") return { state: found.state };
    await this.ctx.storage.put("rec", { ...found.rec, claimed_at_ms: Date.now() } satisfies InviteRecord);
    return { state: "claimed", team_name: found.rec.team_name, inviter: found.rec.inviter, payload: found.rec.payload };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

// ------------------------------------------------------------------------------- the join page

const DEFAULT_DOWNLOAD = "https://github.com/Potato-dev-inc/potato-workspace/releases/latest";

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The deep link the app registers. Only the code and the host that holds it: nothing else is trusted from it. */
export function deepLink(code: string, host: string): string {
  return `potato-workspace://join/${code}?w=${encodeURIComponent(host)}`;
}

/** The one fixed script on the page. The CSP allows exactly this text by its hash, so no 'unsafe-inline' for scripts. */
const AUTO_TRY = `(function(){try{var a=document.getElementById("go");setTimeout(function(){location.href=a.href;setTimeout(function(){document.getElementById("tried").hidden=false},1500)},300)}catch(e){}})()`;

async function sha256b64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The page behind the link. One fixed inline script (the auto-try), no external asset, and it never burns the code. */
export async function joinPage(code: string, host: string, peek: Peek, downloadUrl: string | undefined): Promise<Response> {
  const open = peek.state === "open";
  const team = open ? escapeHtml(peek.team_name || "a team") : "";
  const inviter = open && peek.inviter ? escapeHtml(peek.inviter) : "";
  const download = escapeHtml(/^https:\/\//.test(downloadUrl ?? "") ? (downloadUrl as string) : DEFAULT_DOWNLOAD);
  const dead =
    peek.state === "used"
      ? "This invite was already used. Ask for a new one."
      : peek.state === "expired"
        ? "This invite ran out. Ask for a new one."
        : "This invite link is not valid. Ask for a new one.";
  const link = escapeHtml(deepLink(code, host));
  const body = open
    ? `<h1>Join ${team} in Potato Workspace</h1>
<p>${inviter ? `${inviter} invited you.` : "You were invited."} The link works once.</p>
<p><a class="go" id="go" href="${link}">Open in Potato Workspace</a></p>
<p class="sub" id="tried" hidden>Nothing happened? Press the button again.</p>
<p class="sub">Don't have the app? <a href="${download}">Get it</a>, then open this link again.</p>
<p class="sub">Joining shares your name and what you work on with the team. Your team owner still has to say yes.</p>`
    : `<h1>${dead}</h1>`;
  // One automatic try, so the app opens without a second click. The script is fixed text: nothing from the
  // link or the record is ever put inside it (the address is read from the button).
  const script = open ? `<script>${AUTO_TRY}</script>` : "";
  const scriptSrc = open ? `'sha256-${await sha256b64(AUTO_TRY)}'` : "'none'";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Join a team in Potato Workspace</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#161616;color:#e8e8e8;font:16px/1.5 system-ui,sans-serif}
  main{max-width:24rem;padding:1.5rem;text-align:center}
  h1{font-size:1.15rem;margin:0 0 .75rem}
  p{margin:.5rem 0}
  .sub{color:#a0a0a0;font-size:.9rem}
  a{color:#e8e8e8}
  a.go{display:block;padding:1rem 1.5rem;border-radius:.6rem;background:#e8e8e8;color:#161616;text-decoration:none;font-weight:700;font-size:1.1rem}
</style></head>
<body><main>
${body}
</main>${script}</body></html>`;
  return new Response(html, {
    status: open ? 200 : 410,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptSrc}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
