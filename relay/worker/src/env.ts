import type { IpGate } from "./gate";
import type { Room, RoomIndex } from "./room";
import type { InviteBox } from "./invites";
import type { PairBox, PairIndex } from "./pair";
import type { StableLink } from "./stable";
import type { Team } from "./team";

/** Bindings and optional settings (all the numbers are strings in wrangler vars). */
export interface Env {
  TEAM: DurableObjectNamespace<Team>;
  GATE: DurableObjectNamespace<IpGate>;
  /** Live Rooms: one object per room, and one for the relay's open rooms. */
  ROOM: DurableObjectNamespace<Room>;
  ROOM_INDEX: DurableObjectNamespace<RoomIndex>;
  /** The stable phone link (one object: one Worker serves one PC). */
  LINK: DurableObjectNamespace<StableLink>;
  /** Invite links: one object per one-time code. */
  INVITES: DurableObjectNamespace<InviteBox>;
  /** Far-away pairing: one object per pairing link, and one for the open boxes (the cap). */
  PAIRS: DurableObjectNamespace<PairBox>;
  PAIR_INDEX: DurableObjectNamespace<PairIndex>;
  /** Far-away pairing. Optional. The owner key (base64url Ed25519 public key): only its holder may open a box. Unset = the feature is off. */
  PAIR_OWNER?: string;
  /** Optional. Open pairing boxes at once. Default 50. */
  LIMIT_PAIR_MAX_OPEN?: string;
  /** Stable link. Optional. SHA-256 (hex) of the secret: when set, only that secret may register. */
  SETUP_SECRET_SHA256?: string;
  /** Stable link. Optional. Register/reset attempts per address per hour. Default 30. */
  RATE_LIMIT_PER_HOUR?: string;
  /** TEST ONLY. Replaces the trycloudflare rule. Never set on a real deployment (see wrangler.toml). */
  ALLOWED_ORIGIN_RE?: string;
  /** Optional. Where the join page sends someone who has no app yet. */
  DOWNLOAD_URL?: string;
  /** Optional limits; the defaults match relay/server. */
  LIMIT_DEVICE_PER_MINUTE?: string;
  LIMIT_DEVICE_PER_DAY?: string;
  LIMIT_TEAM_PER_MINUTE?: string;
  LIMIT_DEVICE_REQUESTS_PER_MINUTE?: string;
  LIMIT_JOINS_PER_INVITE?: string;
  LIMIT_JOINS_PER_TEAM_PER_DAY?: string;
  LIMIT_JOINS_PER_ADDRESS_PER_HOUR?: string;
  LIMIT_UNAUTH_PER_IP_PER_HOUR?: string;
  LIMIT_MAX_WAIT_S?: string;
  LIMIT_TEAM_MAX_ENVELOPES?: string;
  LIMIT_TEAM_MAX_BYTES?: string;
  LIMIT_SOCKETS_PER_DEVICE?: string;
  LIMIT_ROOMS_PER_ADDRESS_PER_HOUR?: string;
  LIMIT_ROOM_VIEWS_PER_MINUTE?: string;
  LIMIT_ROOM_MAX_OPEN?: string;
  /** "1" turns on the /v1/_test hooks. Never set it on a real deployment. */
  TEST_HOOKS?: string;
}

/**
 * Limits (SAAS-PLAN §3.5): the same numbers, names and meaning as `Limits` in relay/server
 * (`device_per_minute` is `devicePerMinute` here, and so on). The test hook sets them by these names.
 */
export interface Limits {
  /** Envelopes a device may post per minute / per day. */
  devicePerMinute: number;
  devicePerDay: number;
  /** Envelopes a whole team may post per minute. */
  teamPerMinute: number;
  /** Every signed request of one device (reads included), per minute. */
  deviceRequestsPerMinute: number;
  /** Join requests naming one invite, for a join request's lifetime. */
  joinsPerInvite: number;
  joinsPerTeamPerDay: number;
  /** Join requests per client address per team, per hour. */
  joinsPerAddressPerHour: number;
  /** Team registrations per client address per hour. */
  unauthenticatedPerIpPerHour: number;
  /** Longest long-poll wait, seconds. */
  maxWaitS: number;
  /** What one team may keep in its mailbox at once; more is refused with 507. */
  teamMaxEnvelopes: number;
  teamMaxBytes: number;
  /** Open WebSockets per device. */
  socketsPerDevice: number;
  /** Live Room registrations per client address per hour; viewer calls per address per minute; open rooms. */
  roomsPerAddressPerHour: number;
  roomViewsPerMinute: number;
  roomMaxOpen: number;
}

export const DEFAULT_LIMITS: Limits = {
  devicePerMinute: 60,
  devicePerDay: 5_000,
  teamPerMinute: 600,
  deviceRequestsPerMinute: 300,
  joinsPerInvite: 5,
  joinsPerTeamPerDay: 200,
  joinsPerAddressPerHour: 10,
  unauthenticatedPerIpPerHour: 30,
  maxWaitS: 25,
  teamMaxEnvelopes: 20_000,
  teamMaxBytes: 128 * 1024 * 1024,
  socketsPerDevice: 4,
  roomsPerAddressPerHour: 10,
  roomViewsPerMinute: 120,
  roomMaxOpen: 100,
};

function num(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function limitsFrom(env: Env): Limits {
  return {
    devicePerMinute: num(env.LIMIT_DEVICE_PER_MINUTE, DEFAULT_LIMITS.devicePerMinute),
    devicePerDay: num(env.LIMIT_DEVICE_PER_DAY, DEFAULT_LIMITS.devicePerDay),
    teamPerMinute: num(env.LIMIT_TEAM_PER_MINUTE, DEFAULT_LIMITS.teamPerMinute),
    deviceRequestsPerMinute: num(env.LIMIT_DEVICE_REQUESTS_PER_MINUTE, DEFAULT_LIMITS.deviceRequestsPerMinute),
    joinsPerInvite: num(env.LIMIT_JOINS_PER_INVITE, DEFAULT_LIMITS.joinsPerInvite),
    joinsPerTeamPerDay: num(env.LIMIT_JOINS_PER_TEAM_PER_DAY, DEFAULT_LIMITS.joinsPerTeamPerDay),
    joinsPerAddressPerHour: num(env.LIMIT_JOINS_PER_ADDRESS_PER_HOUR, DEFAULT_LIMITS.joinsPerAddressPerHour),
    unauthenticatedPerIpPerHour: num(env.LIMIT_UNAUTH_PER_IP_PER_HOUR, DEFAULT_LIMITS.unauthenticatedPerIpPerHour),
    maxWaitS: num(env.LIMIT_MAX_WAIT_S, DEFAULT_LIMITS.maxWaitS),
    teamMaxEnvelopes: num(env.LIMIT_TEAM_MAX_ENVELOPES, DEFAULT_LIMITS.teamMaxEnvelopes),
    teamMaxBytes: num(env.LIMIT_TEAM_MAX_BYTES, DEFAULT_LIMITS.teamMaxBytes),
    socketsPerDevice: num(env.LIMIT_SOCKETS_PER_DEVICE, DEFAULT_LIMITS.socketsPerDevice),
    roomsPerAddressPerHour: num(env.LIMIT_ROOMS_PER_ADDRESS_PER_HOUR, DEFAULT_LIMITS.roomsPerAddressPerHour),
    roomViewsPerMinute: num(env.LIMIT_ROOM_VIEWS_PER_MINUTE, DEFAULT_LIMITS.roomViewsPerMinute),
    roomMaxOpen: num(env.LIMIT_ROOM_MAX_OPEN, DEFAULT_LIMITS.roomMaxOpen),
  };
}
