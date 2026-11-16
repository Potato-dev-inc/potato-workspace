// Pure helpers of the crew canvas: where boxes sit, which lines join them, how a crew is edited, and the plain
// sentences for a role's rights. Nothing here draws or calls the app, so it is tested alone (model.test.ts).
import type { Crew, CrewPermissions, CrewRole } from '../../lib/crews-api';

export const BOX_W = 216;
export const BOX_H = 132;
export const GAP_X = 24;
export const GAP_Y = 48;
/** Most boxes in one row; a longer row wraps to the next one, so a whole crew fits a normal window. */
export const ROW_MAX = 4;
export const PAD = 24;
export const MAX_ROLES = 8;
export const MAX_STANDBYS = 4;

export const keyOf = (r: CrewRole): string => (r.id && r.id.trim() ? r.id : r.name);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const isCalled = (r: CrewRole, name: string): boolean => same(keyOf(r), name) || same(r.name, name);
export const findRole = (crew: Crew, name: string): CrewRole | undefined => crew.roles.find((r) => isCalled(r, name));

export interface Spot {
  x: number;
  y: number;
}

/** Where each role's box sits. A saved position wins; the rest are laid out as a tree under their parent. */
export function layout(crew: Crew): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  const depthOf = (role: CrewRole, seen = new Set<string>()): number => {
    if (!role.parent || seen.has(keyOf(role))) return 0;
    seen.add(keyOf(role));
    const parent = findRole(crew, role.parent);
    return parent ? 1 + depthOf(parent, seen) : 0;
  };
  const rows = new Map<number, CrewRole[]>();
  for (const r of crew.roles) {
    const d = depthOf(r);
    rows.set(d, [...(rows.get(d) ?? []), r]);
  }
  const widest = Math.min(ROW_MAX, Math.max(1, ...[...rows.values()].map((row) => row.length)));
  const total = widest * BOX_W + (widest - 1) * GAP_X;
  let visual = 0;
  for (const depth of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(depth) ?? [];
    for (let from = 0; from < row.length; from += ROW_MAX) {
      const chunk = row.slice(from, from + ROW_MAX);
      const width = chunk.length * BOX_W + (chunk.length - 1) * GAP_X;
      chunk.forEach((r, i) => {
        const auto = { x: PAD + (total - width) / 2 + i * (BOX_W + GAP_X), y: PAD + visual * (BOX_H + GAP_Y) };
        spots.set(keyOf(r), r.position ? { x: r.position.x, y: r.position.y } : auto);
      });
      visual++;
    }
  }
  return spots;
}

/** The size the surface needs to hold every box. */
export function extent(spots: Map<string, Spot>): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const s of spots.values()) {
    width = Math.max(width, s.x + BOX_W + PAD);
    height = Math.max(height, s.y + BOX_H + PAD);
  }
  return { width, height };
}

export interface Edge {
  from: string;
  to: string;
  /** team: reports to its parent. hands: hands work on. back: a checker handing work back (the one loop). */
  kind: 'team' | 'hands' | 'back';
}

export function edges(crew: Crew): Edge[] {
  const out: Edge[] = [];
  const has = (from: string, to: string) => out.some((e) => e.from === from && e.to === to);
  for (const r of crew.roles) {
    for (const target of r.hands_to ?? []) {
      const to = findRole(crew, target);
      if (!to || keyOf(to) === keyOf(r) || has(keyOf(r), keyOf(to))) continue;
      const parent = r.parent ? findRole(crew, r.parent) : undefined;
      out.push({ from: keyOf(r), to: keyOf(to), kind: r.check && parent && keyOf(parent) === keyOf(to) ? 'back' : 'hands' });
    }
  }
  for (const r of crew.roles) {
    const parent = r.parent ? findRole(crew, r.parent) : undefined;
    if (parent && !has(keyOf(parent), keyOf(r)) && !has(keyOf(r), keyOf(parent))) out.push({ from: keyOf(parent), to: keyOf(r), kind: 'team' });
  }
  return out;
}

/** The lead is the role with no parent. */
export const leadOf = (crew: Crew): CrewRole | undefined => crew.roles.find((r) => !r.parent);

/** The way a task goes once a role is chosen: the lead, that role, then each checker. */
export function pathFor(crew: Crew, chosen: string): string[] {
  const lead = leadOf(crew);
  const role = findRole(crew, chosen);
  const path = lead ? [keyOf(lead)] : [];
  if (!role) return path;
  if (!path.includes(keyOf(role))) path.push(keyOf(role));
  for (const c of crew.roles.filter((r) => r.check && keyOf(r) !== keyOf(role))) path.push(keyOf(c));
  return path;
}

/** A role is named by its id or name, or by its place in the list (the editor uses the place, so two roles that briefly share a name stay apart). */
export type RoleRef = string | number;
const resolve = (crew: Crew, ref: RoleRef): CrewRole | undefined => (typeof ref === 'number' ? crew.roles[ref] : findRole(crew, ref));

const patch = (crew: Crew, ref: RoleRef, change: Partial<CrewRole>): Crew => {
  const role = resolve(crew, ref);
  return role ? { ...crew, roles: crew.roles.map((r) => (r === role ? { ...r, ...change } : r)) } : crew;
};

export function setRole(crew: Crew, ref: RoleRef, change: Partial<CrewRole>): Crew {
  return patch(crew, ref, change);
}

const NO_RIGHTS: CrewPermissions = { read: true, write: 'none', run: 'none', start_helpers: false, merge: false };

export function setPermissions(crew: Crew, ref: RoleRef, change: Partial<CrewPermissions>): Crew {
  const role = resolve(crew, ref);
  if (!role) return crew;
  return patch(crew, ref, { permissions: { ...(role.permissions ?? NO_RIGHTS), ...change } });
}

/** Rename a role. Roles under it and hand-offs to it follow the new name (a role with an id keeps its id). */
export function renameRole(crew: Crew, ref: RoleRef, next: string): Crew {
  const role = resolve(crew, ref);
  if (!role) return crew;
  const hadId = !!(role.id && role.id.trim());
  const old = keyOf(role);
  const follow = (ref: string) => (same(ref, old) && !hadId ? next : ref);
  return {
    ...crew,
    roles: crew.roles.map((r) => {
      const renamed = r === role ? { ...r, name: next } : r;
      return { ...renamed, parent: renamed.parent ? follow(renamed.parent) : renamed.parent, hands_to: renamed.hands_to?.map(follow) };
    }),
  };
}

export function moveRole(crew: Crew, ref: RoleRef, to: Spot): Crew {
  return patch(crew, ref, { position: { x: Math.max(0, Math.round(to.x)), y: Math.max(0, Math.round(to.y)) } });
}

/** A new helper under `parent`, with a name no role has. */
export function addRole(crew: Crew, parent: string, agent: string, task: string): Crew {
  if (crew.roles.length >= MAX_ROLES) return crew;
  let n = 1;
  while (crew.roles.some((r) => same(r.name, `Helper ${n}`))) n++;
  const parentRole = findRole(crew, parent) ?? leadOf(crew);
  const role: CrewRole = {
    name: `Helper ${n}`,
    agent_type: agent,
    task,
    parent: parentRole ? keyOf(parentRole) : null,
    permissions: { ...NO_RIGHTS },
    standbys: 0,
  };
  return { ...crew, roles: [...crew.roles, role] };
}

/** Take a helper out. The roles under it move up to its parent; hand-offs to it go. The lead stays. */
export function removeRole(crew: Crew, ref: RoleRef): Crew {
  const gone = resolve(crew, ref);
  if (!gone || !gone.parent) return crew;
  const key = keyOf(gone);
  return {
    ...crew,
    roles: crew.roles
      .filter((r) => r !== gone)
      .map((r) => ({
        ...r,
        parent: r.parent && same(r.parent, key) ? gone.parent : r.parent,
        hands_to: r.hands_to?.filter((h) => !same(h, key)),
      })),
  };
}

/** Add or remove a hand-off from one role to another. */
export function toggleHandoff(crew: Crew, from: RoleRef, to: RoleRef): Crew {
  const role = resolve(crew, from);
  const target = resolve(crew, to);
  if (!role || !target || role === target) return crew;
  const list = role.hands_to ?? [];
  const there = list.some((h) => isCalled(target, h));
  return patch(crew, from, { hands_to: there ? list.filter((h) => !isCalled(target, h)) : [...list, keyOf(target)] });
}

/** The rights of a role as message keys (`crewcanvas.right.<key>`), so both languages read them. */
export function rightsKeys(p: CrewPermissions | null | undefined): string[] {
  const perms = p ?? NO_RIGHTS;
  const out: string[] = [perms.read ? 'read' : 'noread', `write.${perms.write}`, `run.${perms.run}`];
  if (perms.start_helpers) out.push('helpers');
  if (perms.merge) out.push('merge');
  return out;
}

/** How many standby helpers a crew keeps ready in all. */
export const standbyTotal = (crew: Crew): number => crew.roles.reduce((n, r) => n + (r.standbys ?? 0), 0);

/** The problems that belong to one role (matched by its name or id). */
export const problemsOf = <P extends { role: string | null }>(problems: P[], role: CrewRole): P[] =>
  problems.filter((p) => p.role !== null && isCalled(role, p.role));

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 1.6;
export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

/** The zoom that shows the whole surface in the room there is (never above 1: small crews are not blown up). */
export function fitZoom(size: { width: number; height: number }, room: { width: number; height: number }): number {
  if (size.width <= 0 || size.height <= 0 || room.width <= 0 || room.height <= 0) return 1;
  return clampZoom(Math.min(1, room.width / size.width, room.height / size.height));
}
