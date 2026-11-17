// Far-away pairing: a small meeting place for two PCs that are not on the same network.
//
// One box per pairing link, named by `rid` (32 bytes, hex, derived from the link's 128-bit seed: never guessable).
// The Worker stores only SEALED messages (the PCs seal them; this file never has a key that opens one) and the
// SHA-256 of three tokens. Who may do what:
//   - create a box:   the Worker's OWNER only (a signed request, `x-pm-auth`, key = PAIR_OWNER). Strangers cannot
//                     make boxes, so an open Worker address is not an open storage space.
//   - host calls:     `x-pm-host` token (a random secret that is NOT in the link): post as host, read the joiner's
//                     messages, delete the box.
//   - joiner calls:   `x-pm-pair` token (derived from the link) to claim, then `x-pm-claim` (given at claim time).
//                     The FIRST claim wins and locks the box (like an invite): a second arrival is told it is used.
//   - everything else is the same 404 as an unknown box, so nothing says whether a box exists.
// Short requests only: a PC polls every second or two. No long waits inside the object, so an idle box keeps no
// object awake (Cloudflare's free plan shares its duration quota across the whole Worker).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export const MIN_TTL_MS = 60 * 1000;
export const MAX_TTL_MS = 10 * 60 * 1000;
/** Messages a box keeps (a pairing is about ten) and the longest sealed message, base64url characters. */
export const MAX_MESSAGES = 40;
export const MAX_CT_CHARS = 32 * 1024;
/** How long an expired box stays so a late caller learns "ran out" rather than "unknown". */
const GRACE_MS = 60 * 1000;

export const isRid = (text: string): boolean => /^[0-9a-f]{64}$/.test(text);
export const isToken = (text: string): boolean => /^[A-Za-z0-9_-]{22,64}$/.test(text);
export const isHash = (text: string): boolean => /^[0-9a-f]{64}$/.test(text);

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const sameHash = (a: string, b: string): boolean => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

/** What a call proves it knows. Tokens arrive raw from the Worker front door; the object compares hashes. */
export interface Who {
  /** `x-pm-pair`: the token derived from the link. */
  pair?: string;
  /** `x-pm-host`: the host's own token. */
  host?: string;
  /** `x-pm-claim`: what the first claimer was given. */
  claim?: string;
}

export interface Answer {
  status: number;
  body: unknown;
}

const NOT_FOUND: Answer = { status: 404, body: { error: "not found" } };
const answer = (status: number, body: unknown = {}): Answer => ({ status, body });

export interface Delivered {
  i: number;
  n: number;
  ct: string;
}

export class PairBox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.ensure());
  }

  /** The tables. The alarm drops them (deleteAll); a call that arrives afterwards finds an empty box (404), never an error. */
  private ensure(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS msgs (i INTEGER PRIMARY KEY AUTOINCREMENT, dir TEXT NOT NULL, n INTEGER NOT NULL, ct TEXT NOT NULL, UNIQUE (dir, n))",
    );
  }

  private get(key: string): string | undefined {
    const rows = this.sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray();
    return rows.length === 0 ? undefined : String(rows[0].v);
  }

  private set(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", key, value);
  }

  /** The box, or a refusal: unknown or ended boxes are the same answer. */
  private open(): { expires: number } | undefined {
    const expires = Number(this.get("expires") ?? 0);
    if (!expires || expires <= Date.now() || this.get("removed") === "1") return undefined;
    return { expires };
  }

  async create(rid: string, pairHash: string, hostHash: string, ttlMs: number): Promise<Answer> {
    this.ensure();
    if (this.get("expires") !== undefined) return answer(409, { error: "exists" });
    const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttlMs));
    const expires = Date.now() + ttl;
    this.set("rid", rid);
    this.set("pair", pairHash);
    this.set("host", hostHash);
    this.set("expires", String(expires));
    await this.ctx.storage.setAlarm(expires + GRACE_MS);
    return answer(201, { expires_at_ms: expires });
  }

  private async isHost(who: Who): Promise<boolean> {
    return who.host !== undefined && sameHash(await sha256Hex(who.host), this.get("host") ?? "");
  }

  private async hasPair(who: Who): Promise<boolean> {
    return who.pair !== undefined && sameHash(await sha256Hex(who.pair), this.get("pair") ?? "");
  }

  private async isJoiner(who: Who): Promise<boolean> {
    const stored = this.get("claim");
    if (stored === undefined || who.claim === undefined || !(await this.hasPair(who))) return false;
    return sameHash(await sha256Hex(who.claim), stored);
  }

  /** The first arrival with the link's token gets the box and a claim token; nobody else ever does. */
  async claim(who: Who): Promise<Answer> {
    this.ensure();
    if (!this.open() || !(await this.hasPair(who))) return NOT_FOUND;
    const token = crypto.getRandomValues(new Uint8Array(16));
    const raw = btoa(String.fromCharCode(...token)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hash = await sha256Hex(raw);
    // One statement decides: INSERT OR IGNORE writes a row only for the first claim, so two claims at the same
    // moment cannot both win, whatever happened between the awaits above.
    const written = this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('claim', ?)", hash).rowsWritten;
    if (written === 0) return answer(409, { error: "claimed" });
    return answer(200, { claim: raw });
  }

  /** `dir` "h" = from the host, "j" = from the joiner. Each sender numbers its own messages from 0. */
  async post(who: Who, dir: string, n: number, ct: string): Promise<Answer> {
    this.ensure();
    if (!this.open()) return NOT_FOUND;
    if (dir === "h") {
      if (!(await this.isHost(who))) return NOT_FOUND;
    } else if (dir === "j") {
      if (!(await this.isJoiner(who))) return NOT_FOUND;
    } else {
      return answer(400, { error: "bad message" });
    }
    if (!Number.isInteger(n) || n < 0 || n > 1000 || typeof ct !== "string" || ct.length === 0 || ct.length > MAX_CT_CHARS || !/^[A-Za-z0-9_-]+$/.test(ct)) {
      return answer(400, { error: "bad message" });
    }
    const count = Number(this.sql.exec("SELECT COUNT(*) AS c FROM msgs").one().c);
    if (count >= MAX_MESSAGES) return answer(429, { error: "box is full" });
    try {
      this.sql.exec("INSERT INTO msgs (dir, n, ct) VALUES (?, ?, ?)", dir, n, ct);
    } catch {
      return answer(409, { error: "duplicate" });
    }
    return answer(200);
  }

  /** What was sent TO `forDir` after position `after`. The host reads what the joiner sent, and the other way round. */
  async poll(who: Who, forDir: string, after: number): Promise<Answer> {
    this.ensure();
    if (!this.open()) return NOT_FOUND;
    if (forDir === "h") {
      if (!(await this.isHost(who))) return NOT_FOUND;
    } else if (forDir === "j") {
      if (!(await this.isJoiner(who))) return NOT_FOUND;
    } else {
      return answer(400, { error: "bad request" });
    }
    const from = forDir === "h" ? "j" : "h";
    const rows = this.sql.exec("SELECT i, n, ct FROM msgs WHERE dir = ? AND i > ? ORDER BY i LIMIT 20", from, Number.isInteger(after) && after >= 0 ? after : 0).toArray();
    const msgs: Delivered[] = rows.map((r) => ({ i: Number(r.i), n: Number(r.n), ct: String(r.ct) }));
    return answer(200, { msgs, claimed: this.get("claim") !== undefined });
  }

  /** Only the host closes the box. */
  async remove(who: Who): Promise<Answer> {
    this.ensure();
    if (!this.open() || !(await this.isHost(who))) return NOT_FOUND;
    await this.wipe();
    return answer(204, null);
  }

  private async wipe(): Promise<void> {
    const rid = this.get("rid");
    // Rows go, the tables stay (deleteAll would drop them). A wiped box answers like an unknown one; only the
    // tombstone stays until the alarm clears everything.
    this.sql.exec("DELETE FROM msgs");
    this.sql.exec("DELETE FROM meta");
    this.set("expires", "1");
    this.set("removed", "1");
    if (rid) {
      try {
        await this.env.PAIR_INDEX.get(this.env.PAIR_INDEX.idFromName("open")).release(rid);
      } catch {
        // the index prunes expired rows by itself
      }
    }
  }

  async alarm(): Promise<void> {
    const rid = this.get("rid");
    await this.ctx.storage.deleteAll();
    if (rid) {
      try {
        await this.env.PAIR_INDEX.get(this.env.PAIR_INDEX.idFromName("open")).release(rid);
      } catch {
        // see wipe
      }
    }
  }
}

/** The relay's open boxes (the cap), built like the Live Room index. */
export class PairIndex extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS open_pairs (rid TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL)");
    });
  }

  async reserve(rid: string, expiresAtMs: number, max: number, now: number): Promise<"ok" | "exists" | "busy"> {
    this.sql.exec("DELETE FROM open_pairs WHERE expires_at_ms <= ?", now);
    if (this.sql.exec("SELECT rid FROM open_pairs WHERE rid = ?", rid).toArray().length > 0) return "exists";
    if (Number(this.sql.exec("SELECT COUNT(*) AS n FROM open_pairs").one().n) >= max) return "busy";
    this.sql.exec("INSERT INTO open_pairs (rid, expires_at_ms) VALUES (?, ?)", rid, expiresAtMs);
    return "ok";
  }

  async release(rid: string): Promise<void> {
    this.sql.exec("DELETE FROM open_pairs WHERE rid = ?", rid);
  }
}
