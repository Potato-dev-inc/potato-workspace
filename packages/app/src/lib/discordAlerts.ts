// Settings > General > Discord alerts: the commands behind the block (`src-tauri/src/discord_alerts`). The webhook
// link goes IN to `discord_alerts_set_url` and never comes back: the status holds only whether one is saved and
// its last four characters.
import { invoke } from '@tauri-apps/api/core';

/** Which alerts to post. */
export interface DiscordKinds {
  needs_you: boolean;
  finished: boolean;
  failed: boolean;
}

export interface DiscordAlertsStatus {
  saved: boolean;
  /** The last four characters of the secret code in the saved link, or null. */
  tail: string | null;
  kinds: DiscordKinds;
  /** A link is saved and at least one kind is on. */
  active: boolean;
}

export interface DiscordTestResult {
  ok: boolean;
  message: string;
}

export interface DiscordAlertsApi {
  status(): Promise<DiscordAlertsStatus>;
  setUrl(url: string): Promise<DiscordAlertsStatus>;
  clear(): Promise<DiscordAlertsStatus>;
  setKinds(kinds: DiscordKinds): Promise<DiscordAlertsStatus>;
  test(): Promise<DiscordTestResult>;
}

export const DEFAULT_DISCORD_KINDS: DiscordKinds = { needs_you: true, finished: false, failed: true };

export const tauriDiscordAlertsApi: DiscordAlertsApi = {
  status: () => invoke<DiscordAlertsStatus>('discord_alerts_status'),
  setUrl: (url) => invoke<DiscordAlertsStatus>('discord_alerts_set_url', { url }),
  clear: () => invoke<DiscordAlertsStatus>('discord_alerts_clear'),
  setKinds: (kinds) => invoke<DiscordAlertsStatus>('discord_alerts_set_kinds', { kinds }),
  test: () => invoke<DiscordTestResult>('discord_alerts_test'),
};

/** A command error as a sentence. */
export function discordErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
