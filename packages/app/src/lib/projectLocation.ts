// Where a project lives: this PC, another Potato PC, or an SSH machine. Mirrors the Rust `ProjectLocation`
// (`src-tauri/src/project_location.rs`). Old saved data has no location and reads as local.

export type ProjectLocation = { kind: 'local' } | { kind: 'device'; node: string; name: string } | { kind: 'ssh'; host_id: string; name: string };

export const LOCAL: ProjectLocation = { kind: 'local' };

export const deviceLocation = (node: string, name: string): ProjectLocation => ({ kind: 'device', node, name });
export const sshLocation = (host_id: string, name: string): ProjectLocation => ({ kind: 'ssh', host_id, name });

const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Anything unknown or malformed reads as local, like saved data from before the field. */
export function parseLocation(v: unknown): ProjectLocation {
  if (!v || typeof v !== 'object') return LOCAL;
  const o = v as Record<string, unknown>;
  if (o.kind === 'device' && str(o.node)) return deviceLocation(str(o.node), str(o.name));
  if (o.kind === 'ssh' && str(o.host_id)) return sshLocation(str(o.host_id), str(o.name));
  return LOCAL;
}

/** The small badge beside a project's name: the PC's name, `ssh (name)`, or null for this PC. */
export function locationBadge(loc: ProjectLocation): string | null {
  if (loc.kind === 'device') return loc.name;
  if (loc.kind === 'ssh') return `ssh (${loc.name})`;
  return null;
}

/**
 * The project path of a folder on an SSH machine. It is the SAME text the backend gives that chat's pane as its folder
 * (`ssh::acp::pane_folder`): a NUL, `ssh://`, the saved machine's id, then the folder there. Two machines with the same folder are two
 * projects, and it names no folder of this PC, so nothing here can read or write one. Local projects keep their plain path.
 */
const REMOTE_PREFIX = '\u0000ssh://';
export const remoteProjectPath = (hostId: string, folder: string): string => `${REMOTE_PREFIX}${hostId}${folder}`;

/** `{ hostId, folder }` of a path made by `remoteProjectPath`, or null for a path of this PC. */
export function remoteProjectParts(path: string): { hostId: string; folder: string } | null {
  if (!path.startsWith(REMOTE_PREFIX)) return null;
  const rest = path.slice(REMOTE_PREFIX.length);
  // A host id holds only letters, digits and `-`; the folder starts at the first other character (`/`, or `~` of `~/x`).
  const at = rest.search(/[^A-Za-z0-9-]/);
  return at > 0 ? { hostId: rest.slice(0, at), folder: rest.slice(at) } : null;
}
