// Over SSH for the harness and the tests (dev only): example machines and checks, the mocked `ssh_*` commands, and `SshFake`,
// an `SshApi` that keeps its own small state. No real SSH host is ever contacted.
import type { SshApi, SshCheck, SshHost, SshParts } from '../lib/ssh';

export const BUILD_BOX: SshHost = {
  id: 'ssh-1',
  name: 'Build box',
  user: 'dev',
  host: 'build.local',
  port: 22,
  keyFile: null,
  os: 'Linux',
  checkedAt: 1_700_000_000,
  agents: [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
  ],
};

export const CHECK_OK: SshCheck = {
  state: 'ok',
  message: 'Connected.',
  os: 'Linux',
  programs: [
    { id: 'git', label: 'git', kind: 'tool', found: true },
    { id: 'node', label: 'node', kind: 'tool', found: true },
    { id: 'claude', label: 'Claude', kind: 'agent', found: true },
    { id: 'codex', label: 'Codex', kind: 'agent', found: false },
  ],
};

export const failed = (state: SshCheck['state'], line?: string): SshCheck => ({ state, message: '', os: null, programs: [], ...(line ? { line } : {}) });

export interface SshScenario {
  hosts?: SshHost[];
  /** What a check answers. */
  check?: SshCheck;
}

type Handler = { handled: true; value: unknown } | { handled: false };

/** The mocked `ssh_*` commands of the harness. */
export function sshMock(s: SshScenario | undefined, cmd: string, args: Record<string, unknown>): Handler {
  if (!cmd.startsWith('ssh_')) return { handled: false };
  switch (cmd) {
    case 'ssh_hosts':
      return { handled: true, value: s?.hosts ?? [] };
    case 'ssh_check':
    case 'ssh_check_saved':
      return { handled: true, value: s?.check ?? CHECK_OK };
    case 'ssh_add':
      return { handled: true, value: { ...BUILD_BOX, name: String(args.name || 'Build box') } };
    case 'ssh_remove':
      return { handled: true, value: true };
    case 'ssh_open':
      return { handled: true, value: 'ssh-pane-1' };
    default:
      return { handled: false };
  }
}

export interface SshCall {
  method: 'check' | 'add' | 'checkSaved' | 'remove' | 'open';
  args: unknown[];
}

/** An `SshApi` with its own state. `checkResult` is what every check answers. */
export class SshFake implements SshApi {
  hostList: SshHost[];
  checkResult: SshCheck;
  calls: SshCall[] = [];
  opened: { id: string; agent: string; folder?: string }[] = [];
  constructor(opts: { hosts?: SshHost[]; check?: SshCheck } = {}) {
    this.hostList = [...(opts.hosts ?? [])];
    this.checkResult = opts.check ?? CHECK_OK;
  }
  async hosts() {
    return [...this.hostList];
  }
  async check(parts: SshParts) {
    this.calls.push({ method: 'check', args: [parts] });
    return this.checkResult;
  }
  async add(name: string, parts: SshParts, check: SshCheck | null) {
    this.calls.push({ method: 'add', args: [name, parts, check] });
    const [user = '', host = ''] = parts.target.split('@');
    const saved: SshHost = {
      id: `ssh-${this.hostList.length + 1}`,
      name: name || host,
      user,
      host,
      port: parts.port ?? 22,
      keyFile: parts.keyFile ?? null,
      os: check?.state === 'ok' ? check.os : null,
      checkedAt: null,
      agents: check?.state === 'ok' ? check.programs.filter((p) => p.kind === 'agent' && p.found).map((p) => ({ id: p.id, label: p.label })) : [],
    };
    this.hostList.push(saved);
    return saved;
  }
  async checkSaved(id: string) {
    this.calls.push({ method: 'checkSaved', args: [id] });
    return this.checkResult;
  }
  async remove(id: string) {
    this.calls.push({ method: 'remove', args: [id] });
    this.hostList = this.hostList.filter((h) => h.id !== id);
    return true;
  }
  async open(id: string, agent: string, folder?: string) {
    this.calls.push({ method: 'open', args: [id, agent, folder] });
    this.opened.push({ id, agent, ...(folder ? { folder } : {}) });
    return `ssh-pane-${this.opened.length}`;
  }
}
