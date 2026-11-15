/**
 * What this Worker can do, advertised by `GET /v1/health` and `GET /_pm/health`. The app reads this before it
 * sends anything: a feature that is missing means an older deploy ("Update your Worker"), and a secret is
 * never sent to an address that does not list the feature it is for.
 */
export const WORKER_NAME = "potato-worker/1";
export const FEATURES = ["team", "rooms", "stable-link", "invites"] as const;
export type Feature = (typeof FEATURES)[number];
