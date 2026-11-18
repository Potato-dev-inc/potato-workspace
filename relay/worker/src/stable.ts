import { DurableObject } from "cloudflare:workers";
import { safeEqual } from "./stablecrypto";
import type { Env } from "./env";

/** Only a quick-tunnel address may be linked: no open proxy, no SSRF. */
export const DEFAULT_ORIGIN_RE = "^https://[a-z0-9-]+\\.trycloudflare\\.com$";
const HOUR = 60 * 60 * 1000;
const MAX_TRACKED_ADDRESSES = 1000;

export type Outcome = { status: 200 | 400 | 403 | 429; error?: string };
export type Health = { linked: boolean; updated_at: number | null };

type Window = { start: number; count: number };

export function originRule(env: Env): RegExp {
  if (env.ALLOWED_ORIGIN_RE) {
    try {
      return new RegExp(env.ALLOWED_ORIGIN_RE);
    } catch {
      // a broken test override must never loosen the rule
    }
  }
  return new RegExp(DEFAULT_ORIGIN_RE);
}

/**
 * The one place the link lives: the PC's current quick-tunnel address, the SHA-256 of its secret and
 * the per-address attempt counters. One object, so a new address is visible to the next request at once.
 */
export class StableLink extends DurableObject<Env> {
  /** Count one register/reset attempt of `address` this hour; false when over the limit. */
  private async allow(address: string): Promise<boolean> {
    const now = Date.now();
    const limit = Number.parseInt(this.env.RATE_LIMIT_PER_HOUR ?? "", 10) || 30;
    const all = (await this.ctx.storage.get<Record<string, Window>>("attempts")) ?? {};
    for (const [key, window] of Object.entries(all)) if (now - window.start >= HOUR) delete all[key];
    const keys = Object.keys(all);
    if (keys.length >= MAX_TRACKED_ADDRESSES && !all[address]) delete all[keys[0]];
    const window = all[address] ?? { start: now, count: 0 };
    window.count += 1;
    all[address] = window;
    await this.ctx.storage.put("attempts", all);
    return window.count <= limit;
  }

  /** Who may act: the setup secret when one is configured, else the secret seen first ("first" = nobody yet). */
  private async check(secretHash: string): Promise<"ok" | "first" | "wrong"> {
    const setup = (this.env.SETUP_SECRET_SHA256 ?? "").trim().toLowerCase();
    if (setup) return safeEqual(secretHash, setup) ? "ok" : "wrong";
    const stored = await this.ctx.storage.get<string>("secret_hash");
    if (!stored) return "first";
    return safeEqual(secretHash, stored) ? "ok" : "wrong";
  }

  async register(secretHash: string, origin: unknown, address: string): Promise<Outcome> {
    if (!(await this.allow(address))) return { status: 429, error: "too_many_attempts" };
    const who = await this.check(secretHash);
    if (who === "wrong") return { status: 403, error: "secret_mismatch" };
    if (typeof origin !== "string" || origin.length > 200 || !originRule(this.env).test(origin)) {
      return { status: 400, error: "origin_not_allowed" };
    }
    if (who === "first") await this.ctx.storage.put("secret_hash", secretHash);
    await this.ctx.storage.put({ origin, updated_at: Date.now() });
    return { status: 200 };
  }

  /** Clear the link and the stored secret (the next register starts fresh). */
  async reset(secretHash: string, address: string): Promise<Outcome> {
    if (!(await this.allow(address))) return { status: 429, error: "too_many_attempts" };
    const who = await this.check(secretHash);
    if (who === "wrong") return { status: 403, error: "secret_mismatch" };
    await this.ctx.storage.delete(["origin", "updated_at", "secret_hash"]);
    return { status: 200 };
  }

  async health(): Promise<Health> {
    const origin = await this.ctx.storage.get<string>("origin");
    const updated = await this.ctx.storage.get<number>("updated_at");
    return { linked: Boolean(origin), updated_at: origin ? (updated ?? null) : null };
  }

  async origin(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("origin")) ?? null;
  }
}
