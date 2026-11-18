// Over SSH (Devices phase 3): a machine that takes an SSH login becomes a place to run a terminal or a CLI agent.
//
// The Rust side (src-tauri/src/ssh, commands/ssh.rs) holds everything. This file is the typed command surface and the
// words. The screens give it parts (`user@host`, a port, a key file PATH), never a command line. No password is ever
// asked for or kept here: the terminal asks for it itself. Text from the far machine is untrusted: render it as text.
import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';

export type SshStateName = 'ok' | 'cannot_reach' | 'wrong_key' | 'host_key_unknown' | 'host_key_changed' | 'other';

export interface SshProgramRow {
  /** `git`, `node`, or an agent id. */
  id: string;
  label: string;
  kind: 'tool' | 'agent';
  found: boolean;
}

export interface SshCheck {
  state: SshStateName;
  /** The far machine's own first line, for `other` only. Untrusted text. */
  line?: string;
  message: string;
  os: string | null;
  programs: SshProgramRow[];
}

export interface SshHost {
  id: string;
  name: string;
  user: string;
  host: string;
  port: number;
  /** A path. It is shown, never read. */
  keyFile: string | null;
  os: string | null;
  checkedAt: number | null;
  /** The agent CLIs the last check found. */
  agents: { id: string; label: string }[];
}

export interface SshParts {
  target: string;
  port?: number;
  keyFile?: string;
}

export interface SshApi {
  hosts: () => Promise<SshHost[]>;
  /** A read-only check of a machine that is not saved yet. */
  check: (parts: SshParts) => Promise<SshCheck>;
  add: (name: string, parts: SshParts, check: SshCheck | null) => Promise<SshHost>;
  checkSaved: (id: string) => Promise<SshCheck>;
  remove: (id: string) => Promise<boolean>;
  /** Opens a terminal on a saved machine. `agent` is `shell` or an agent id. Resolves to the pane id. */
  open: (id: string, agent: string, folder?: string) => Promise<string>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(`Desktop shell required: ${command}`));
  return invoke<T>(command, args);
}

export const sshApi: SshApi = {
  hosts: () => call('ssh_hosts'),
  check: (p) => call('ssh_check', { target: p.target, port: p.port ?? null, keyFile: p.keyFile ?? null }),
  add: (name, p, check) =>
    call('ssh_add', {
      name,
      target: p.target,
      port: p.port ?? null,
      keyFile: p.keyFile ?? null,
      found: check && check.state === 'ok' ? check.programs.filter((r) => r.found && r.kind === 'tool').map((r) => r.id).concat(check.programs.filter((r) => r.found && r.kind === 'agent').map((r) => r.id)) : null,
      os: check && check.state === 'ok' ? check.os : null,
    }),
  checkSaved: (id) => call('ssh_check_saved', { id }),
  remove: (id) => call('ssh_remove', { id }),
  open: (id, agent, folder) => call('ssh_open', { id, agent, folder: folder ?? null }),
};

/** Plain words for a failed check. Null when it worked. */
export function sshStateSentence(c: Pick<SshCheck, 'state' | 'line'>, plain = false): string | null {
  switch (c.state) {
    case 'ok':
      return null;
    case 'cannot_reach':
      return t('devices.ssh.cannotReach');
    case 'wrong_key':
      return t(plain ? 'devices.ssh.wrongKeyPlain' : 'devices.ssh.wrongKey');
    case 'host_key_unknown':
      return t('devices.ssh.hostKeyUnknown');
    case 'host_key_changed':
      return t('devices.ssh.hostKeyChanged');
    default: {
      // eslint-disable-next-line no-control-regex
      const line = typeof c.line === 'string' ? c.line.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160) : '';
      return line ? t('devices.ssh.other', { line }) : t('devices.ssh.otherPlain');
    }
  }
}

/** `user@host`, a port, a key file path: whether the form can be checked. A hint only: the backend decides. */
export function sshFormReady(target: string, port: string): boolean {
  const t0 = target.trim();
  const at = t0.lastIndexOf('@');
  if (at < 1 || at === t0.length - 1 || /\s/.test(t0)) return false;
  if (port.trim() === '') return true;
  return /^\d{1,5}$/.test(port.trim()) && +port.trim() >= 1 && +port.trim() <= 65535;
}

/** The part of the check that lists what is there: the OS, then git, node and each agent. */
export function checkLines(c: SshCheck): { id: string; text: string; found: boolean }[] {
  return c.programs.map((p) => ({
    id: p.id,
    found: p.found,
    text: p.found ? (p.kind === 'agent' ? t('devices.ssh.agentTerminal', { name: p.label }) : p.label) : t('devices.ssh.notFound', { name: p.label }),
  }));
}

/** The agent list of a saved machine for New agent: a plain shell, then each agent the check found. Never a chat. */
export function sshAgents(h: Pick<SshHost, 'agents'>): { id: string; label: string }[] {
  return [{ id: 'shell', label: t('devices.ssh.shell') }, ...h.agents];
}
