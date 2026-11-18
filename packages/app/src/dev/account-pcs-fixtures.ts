// Two (or three) PCs of one account for the screens (dev and tests only): each has its own settings, its own Devices state and
// its own account commands, and they share one address book. It keeps the rules of the real thing that matter on screen: a PC
// is listed as openable only while its owner has the tick on; the first Open shows a number sheet on BOTH PCs and pairs only if
// the person at the opened PC types the six digits the other PC shows; a pairing through the account never grants a right; signing out
// takes a PC out of the others' lists.
import type { AccountApi, AccountDevice, AccountPc, AccountPcsReply, AccountView, OpenedPc } from '../lib/account';
import type { Device, PendingPair } from '../lib/devices';
import { DevicesFake, MAC_MINI } from './devices-fixtures';

const NOW = Math.floor(Date.now() / 1000);

export class AccountWorld {
  pcs: WorldPc[] = [];
  /** Tell every PC's page the account changed (the real page also asks again every few seconds). */
  changed(): void {
    for (const pc of this.pcs) pc.fire();
  }
  add(opts: { id: string; name: string; node: string; tick?: boolean; createdAgoSecs?: number }): WorldPc {
    const pc = new WorldPc(this, opts);
    this.pcs.push(pc);
    return pc;
  }
}

export class WorldPc {
  /** "Let my other PCs open this PC": the app window's own switch (not one of the settings a phone or an agent can patch). */
  tick: boolean;
  signedIn = true;
  readonly id: string;
  readonly name: string;
  readonly node: string;
  readonly createdAt: number;
  readonly devices: DevicesFake;
  /** Every call this PC's page made to the account, in order. */
  calls: string[] = [];
  /** What this PC's settings say besides the tick. */
  private listeners = new Set<() => void>();

  constructor(
    private readonly world: AccountWorld,
    opts: { id: string; name: string; node: string; tick?: boolean; createdAgoSecs?: number },
  ) {
    this.id = opts.id;
    this.name = opts.name;
    this.node = opts.node;
    this.tick = opts.tick === true;
    this.createdAt = NOW - (opts.createdAgoSecs ?? 30 * 86400);
    this.devices = new DevicesFake({ name: opts.name, devices: [] });
  }

  fire(): void {
    for (const cb of this.listeners) cb();
  }

  setTick(on: boolean): void {
    this.tick = on;
    this.world.changed();
  }

  private view(): AccountView {
    return {
      configured: true,
      signed_in: this.signedIn,
      waiting: false,
      message: null,
      account: this.signedIn ? { id: 'acct-1', display_name: 'Test Person', provider: 'discord' } : null,
      device_id: this.signedIn ? this.id : null,
    };
  }

  private rowFor(other: WorldPc): AccountPc {
    const paired = this.devices.view.devices.find((d) => d.node === other.node);
    const status: AccountPc['status'] = !other.tick ? 'allow_there' : !paired ? 'new' : paired.state === 'online' ? 'online' : paired.state === 'not_allowed' ? 'not_allowed' : 'away';
    return {
      id: other.id,
      name: other.name,
      status,
      online: true,
      last_seen_at: NOW,
      created_at: other.createdAt,
      recent: NOW - other.createdAt < 86400,
      node: other.tick ? other.node : null,
    };
  }

  /** The account commands this PC's page uses. */
  readonly api: AccountApi = {
    state: async () => this.view(),
    signIn: async () => this.view(),
    cancel: async () => this.view(),
    devices: async () => ({
      signed_in: this.signedIn,
      devices: this.signedIn
        ? this.world.pcs
            .filter((p) => p.signedIn)
            .map<AccountDevice>((p) => ({ id: p.id, kind: 'pc', name: p.name, created_at: p.createdAt, last_seen_at: NOW, online: true, revoked: false, not_me: false, is_this: p === this }))
        : [],
    }),
    revoke: async () => ({ signed_in: this.signedIn, devices: [] }),
    signOutHere: async () => {
      this.calls.push('signOutHere');
      this.signedIn = false;
      this.world.changed();
      return this.view();
    },
    pcs: async (): Promise<AccountPcsReply> => {
      this.calls.push('pcs');
      return {
        available: true,
        signed_in: this.signedIn,
        open_here: this.tick,
        published: this.tick && this.signedIn,
        pcs: this.signedIn ? this.world.pcs.filter((p) => p !== this && p.signedIn).map((p) => this.rowFor(p)) : [],
      };
    },
    openPc: (id: string) => this.open(id),
    setOpenHere: async (on: boolean) => this.setTick(on),
    onChanged: async (cb) => {
      this.listeners.add(cb);
      return () => void this.listeners.delete(cb);
    },
  };

  /** Pressing Open here, on `id`. The sheets show on both PCs; it finishes when both people have answered. */
  private async open(id: string): Promise<OpenedPc> {
    this.calls.push(`open ${id}`);
    const other = this.world.pcs.find((p) => p.id === id && p.signedIn);
    if (!other || !other.tick) throw new Error('That PC has not been allowed to be opened yet. On that PC, tick "Let my other PCs open this PC".');
    const already = this.devices.view.devices.find((d) => d.node === other.node);
    if (already) return { paired: true, node: other.node, name: other.name, state: already.state };
    const right = '482913';
    // The PC being opened shows no number (its person types the six digits); the PC pressing Open shows them.
    const sheet = (role: 'host' | 'joiner', name: string, firstSeen: number): PendingPair => ({
      id: role === 'host' ? 2 : 1,
      role,
      name,
      code: '',
      expires_at: Date.now() + 120_000,
      mode: role === 'host' ? 'type' : 'show',
      fingerprint: role === 'host' ? 'A1B2 C3D4' : 'E5F6 0718',
      ...(role === 'host' ? {} : { number: right }),
      account: { first_seen: firstSeen },
    });
    // A No on either PC ends it at once (the other PC is told); a pick is waited for on both.
    let decline: () => void = () => {};
    const declined = new Promise<'declined'>((resolve) => (decline = () => resolve('declined')));
    const answer = (who: WorldPc, p: PendingPair) =>
      new Promise<{ pick: string | null }>((resolve) =>
        who.devices.showPending(p, (pick) => {
          if (pick === null) decline();
          resolve({ pick });
        }),
      );
    const both = Promise.all([answer(this, sheet('joiner', other.name, other.createdAt)), answer(other, sheet('host', this.name, this.createdAt))]);
    const result = await Promise.race([both, declined]);
    this.devices.clearPending();
    other.devices.clearPending();
    if (result === 'declined') throw new Error('The other PC said no.');
    const [mine, theirs] = result;
    // The person here said "I typed them" and the person there typed the right six digits.
    if (mine.pick !== 'yes' || theirs.pick !== right) throw new Error('That was not the matching number. Pairing stopped.');
    // Both said yes. Nothing is shared: a pairing through the account never grants a right.
    this.devices.addPairedDevice({ ...MAC_MINI, node: other.node, name: other.name, state: 'not_allowed', lets_run: false, level: 'watch' });
    other.devices.addPairedDevice({ ...MAC_MINI, node: this.node, name: this.name, state: 'online', lets_run: false, level: 'watch' });
    this.world.changed();
    return { paired: true, node: other.node, name: other.name, state: 'not_allowed' };
  }
}

// ---------- the harness (headless screenshots): the mocked account commands for one PC ----------

/** What the harness's mocked account answers: signed in as a person, with these other PCs, and the tick as this PC has it. */
export interface AccountScenario {
  signedIn?: boolean;
  /** "Let my other PCs open this PC" is ticked on this PC. */
  tick?: boolean;
  pcs: AccountPc[];
}

type MockHandler = { handled: true; value: unknown } | { handled: false };

export function createAccountMock(s: AccountScenario | undefined): (cmd: string, args: Record<string, unknown>) => MockHandler {
  const signed = s?.signedIn !== false;
  const view: AccountView = {
    configured: true,
    signed_in: signed,
    waiting: false,
    message: null,
    account: signed ? { id: 'acct-1', display_name: 'Ren', provider: 'discord' } : null,
    device_id: signed ? 'dev-this' : null,
  };
  return (cmd) => {
    if (!s) return { handled: false };
    switch (cmd) {
      case 'account_state':
        return { handled: true, value: view };
      case 'account_devices':
        return { handled: true, value: { signed_in: signed, devices: [] } };
      case 'devices_account_pcs':
        return { handled: true, value: { available: true, signed_in: signed, open_here: s.tick === true, published: s.tick === true, pcs: s.pcs } satisfies AccountPcsReply };
      case 'devices_set_open_from_account':
        return { handled: true, value: null };
      case 'devices_open_account_pc':
        // The pairing is waiting for both people: it does not answer while the screenshot is taken.
        return { handled: true, value: new Promise(() => undefined) };
      default:
        return { handled: false };
    }
  };
}

export const SAMPLE_PCS: AccountPc[] = [
  { id: 'pc-desk', name: 'Office PC', status: 'new', online: true, last_seen_at: NOW, created_at: NOW - 40 * 86400, recent: false, node: 'c3'.repeat(32) },
  { id: 'pc-mini', name: 'Mac mini', status: 'online', online: true, last_seen_at: NOW, created_at: NOW - 90 * 86400, recent: false, node: 'a1'.repeat(32) },
  { id: 'pc-studio', name: 'Studio laptop', status: 'allow_there', online: true, last_seen_at: NOW - 120, created_at: NOW - 3600, recent: true, node: null },
];
