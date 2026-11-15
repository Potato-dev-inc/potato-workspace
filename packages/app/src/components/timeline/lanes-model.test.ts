// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { FIXTURE_NOW, NOTES, PM, SITE, WORKTREE, row, sampleDay } from '../../dev/timeline-fixtures';
import type { TimelineDay, TimelineLane } from '../../lib/timeline';
import {
  CLUSTER_MIN,
  FOLD_GAP_MS,
  FOLD_WIDTH_PX,
  buildAxis,
  buildLanes,
  clock,
  clusterWindow,
  dayWindow,
  hourWindow,
  laneItems,
  markLabel,
  markOrder,
  snapMark,
  stepLane,
  stepMark,
} from './lanes-model';

const MIN = 60_000;
const at = (h: number, m: number) => new Date(2026, 10, 15, h, m).getTime();

function laneOf(project: string, rows: ReturnType<typeof row>[]): TimelineLane {
  return { project, name: project.split('/').pop() ?? project, folderGone: false, rows, lastMs: Math.max(...rows.map((r) => r.atMs)) };
}

function dayOf(...lanes: TimelineLane[]): TimelineDay {
  return { date: '2026-11-15', today: '2026-11-15', nowMs: FIXTURE_NOW, lanes, dates: [] };
}

describe('lanes', () => {
  it('turns rows of 3 projects into 3 lanes, the most recent activity first', () => {
    const day = dayOf(
      laneOf(NOTES, [row({ project: NOTES, key: 'a', id: '1', atMs: at(9, 0) })]),
      laneOf(PM, [row({ project: PM, key: 'b', id: '1', atMs: at(11, 0) })]),
      laneOf(SITE, [row({ project: SITE, key: 'c', id: '1', atMs: at(10, 0) })]),
    );
    expect(buildLanes(day).map((l) => l.name)).toEqual(['pm-workspace', 'potato-site', 'notes']);
  });

  it('draws only finished turns, stops and go-backs; a turn with no changed files is hollow', () => {
    const day = dayOf(
      laneOf(PM, [
        row({ project: PM, key: 'a', id: '1', atMs: at(9, 0), kind: 'before' }),
        row({ project: PM, key: 'a', id: '2', atMs: at(9, 5), kind: 'after' }),
        row({ project: PM, key: 'a', id: '3', atMs: at(9, 6), kind: 'after', files: 0 }),
        row({ project: PM, key: 'a', id: '4', atMs: at(9, 7), kind: 'stop' }),
        row({ project: PM, key: 'a', id: '5', atMs: at(9, 8), kind: 'answer' }),
        row({ project: PM, key: 'day', id: '1', atMs: at(9, 9), kind: 'undo' }),
      ]),
    );
    expect(buildLanes(day)[0].marks.map((m) => m.shape)).toEqual(['turn', 'hollow', 'stop', 'undo']);
  });

  it('hides a helper\'s own steps unless asked, and filters by project and agent', () => {
    const day = dayOf(
      laneOf(PM, [
        row({ project: PM, key: 'a', id: '1', atMs: at(9, 0), agentType: 'claude' }),
        row({ project: PM, key: 'b', id: '1', atMs: at(9, 5), agentType: 'codex' }),
        row({ project: PM, key: 'mission-1', id: '1', atMs: at(9, 6), agentType: '', helper: true, kind: 'after' }),
      ]),
      laneOf(SITE, [row({ project: SITE, key: 'c', id: '1', atMs: at(9, 10), agentType: 'claude' })]),
    );
    const base = { project: 'all', agent: 'all', showHelpers: false };
    expect(markOrder(buildLanes(day, base))).toHaveLength(3);
    expect(markOrder(buildLanes(day, { ...base, showHelpers: true }))).toHaveLength(4);
    expect(buildLanes(day, { ...base, agent: 'codex' }).map((l) => l.name)).toEqual(['pm-workspace']);
    expect(buildLanes(day, { ...base, project: SITE }).map((l) => l.name)).toEqual(['potato-site']);
    // A go-back stays when filtering by agent: it has no agent, and it is the person's.
    const withUndo = dayOf(laneOf(PM, [row({ project: PM, key: 'a', id: '1', atMs: at(9, 0), agentType: 'claude' }), row({ project: PM, key: 'day', id: '1', atMs: at(9, 9), kind: 'undo', agentType: '' })]));
    expect(markOrder(buildLanes(withUndo, { ...base, agent: 'codex' })).map((m) => m.shape)).toEqual(['undo']);
  });

  it('draws a helper\'s worktree inside its parent\'s lane with a branch tick', () => {
    const day = sampleDay();
    const lanes = buildLanes(day);
    expect(lanes.map((l) => l.project)).not.toContain(WORKTREE);
    const pm = lanes.find((l) => l.project === PM)!;
    const branch = pm.marks.filter((m) => m.branch);
    expect(branch.length).toBe(4);
    expect(branch.every((m) => m.row.project === WORKTREE)).toBe(true);
    // The go back from there still names the worktree's own folder.
    expect(markOrder(lanes).find((m) => m.branch)!.row.project).toBe(WORKTREE);
  });

  it('fades pruned points', () => {
    const lanes = buildLanes(sampleDay());
    const pm = lanes.find((l) => l.project === PM)!;
    expect(pm.marks.filter((m) => m.faded).length).toBe(10);
    expect(pm.marks.find((m) => m.faded)!.row.atMs).toBeLessThan(pm.marks.find((m) => !m.faded)!.row.atMs + 1);
  });

  it('builds a day of about a hundred and twenty marks', () => {
    const count = markOrder(buildLanes(sampleDay())).length;
    expect(count).toBeGreaterThan(100);
    expect(count).toBeLessThan(140);
  });
});

describe('axis', () => {
  const start = at(9, 0);
  const end = at(15, 30);

  it('maps times to pixels and back, in order', () => {
    const axis = buildAxis([at(9, 30), at(10, 0), at(10, 30)], at(9, 0), at(11, 0), 600);
    expect(axis.folds).toHaveLength(0);
    expect(axis.xOf(at(9, 0))).toBe(0);
    expect(axis.xOf(at(11, 0))).toBeCloseTo(600);
    expect(axis.xOf(at(10, 0))).toBeCloseTo(300);
    expect(axis.msAt(300)).toBeCloseTo(at(10, 0), -2);
    expect(axis.ticks.map((tick) => clock(tick.ms))).toEqual(['09:00', '10:00', '11:00']);
  });

  it('folds an idle gap over an hour into a short dashed break', () => {
    const times = [at(11, 40), at(12, 0), at(13, 30), at(13, 40)];
    const axis = buildAxis(times, at(11, 30), at(13, 50), 800);
    expect(axis.folds).toHaveLength(1);
    const fold = axis.folds[0];
    expect(fold.x1 - fold.x0).toBeCloseTo(FOLD_WIDTH_PX);
    expect(fold.fromMs).toBe(at(12, 10));
    expect(fold.toMs).toBe(at(13, 20));
    // Ninety minutes with a break in the middle take less room than they would without it.
    expect(axis.xOf(at(13, 30)) - axis.xOf(at(12, 0))).toBeLessThan((90 / 140) * 800);
    // No hour tick inside the break.
    expect(axis.ticks.map((tick) => clock(tick.ms))).toEqual(['12:00']);
    // A pointer in the break lands on the nearer edge.
    expect(axis.msAt(fold.x0 + 2)).toBe(fold.fromMs);
    expect(axis.msAt(fold.x1 - 2)).toBe(fold.toMs);
    expect(axis.xOf(at(13, 50))).toBeCloseTo(800);
  });

  it('does not fold a gap of exactly an hour', () => {
    const axis = buildAxis([at(9, 0) + FOLD_GAP_MS], at(9, 0), at(10, 30), 600);
    expect(axis.folds).toHaveLength(0);
  });

  it('keeps the whole sample day inside its width with its lunch folded', () => {
    const lanes = buildLanes(sampleDay());
    const win = dayWindow(lanes, FIXTURE_NOW, true);
    const axis = buildAxis(markOrder(lanes).map((m) => m.row.atMs), win.startMs, win.endMs, 1000);
    expect(win.startMs).toBeLessThan(start);
    expect(win.endMs).toBeGreaterThanOrEqual(FIXTURE_NOW);
    expect(end).toBe(FIXTURE_NOW);
    expect(axis.folds.length).toBeGreaterThanOrEqual(1);
    expect(axis.xOf(win.endMs)).toBeCloseTo(1000);
  });

  it('zooms to an hour around a time', () => {
    const w = hourWindow(at(14, 10));
    expect(w.endMs - w.startMs).toBe(60 * MIN);
    expect(clock(w.startMs)).toBe('13:40');
  });
});

describe('busy stretches', () => {
  it('joins more than six marks within 24 px into a pill with a count, and leaves sparse marks alone', () => {
    const lanes = buildLanes(sampleDay());
    const pm = lanes.find((l) => l.project === PM)!;
    const win = dayWindow(lanes, FIXTURE_NOW, true);
    const axis = buildAxis(markOrder(lanes).map((m) => m.row.atMs), win.startMs, win.endMs, 900);
    const items = laneItems(pm.marks, axis);
    const clusters = items.filter((i) => i.type === 'cluster');
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    for (const c of clusters) if (c.type === 'cluster') expect(c.marks.length).toBeGreaterThan(CLUSTER_MIN);
    // Every mark is either single or inside exactly one pill.
    const covered = items.reduce((n, i) => n + (i.type === 'mark' ? 1 : i.marks.length), 0);
    expect(covered).toBe(pm.marks.length);
    // Opening the pill zooms to just that stretch, which pulls it apart.
    const pill = clusters[0];
    if (pill.type !== 'cluster') throw new Error('expected a pill');
    const window = clusterWindow(pill.marks);
    const zoomed = buildAxis(markOrder(lanes).map((m) => m.row.atMs), window.startMs, window.endMs, 900);
    const pulled = laneItems(pm.marks, zoomed);
    expect(pulled.filter((i) => i.type === 'cluster')).toHaveLength(0);
    expect(pulled.filter((i) => i.type === 'mark').length).toBeGreaterThanOrEqual(pill.marks.length);
  });

  it('only counts marks that are in the window', () => {
    const lanes = buildLanes(sampleDay());
    const pm = lanes.find((l) => l.project === PM)!;
    const axis = buildAxis([], at(13, 40), at(14, 40), 900);
    const inside = laneItems(pm.marks, axis).reduce((n, i) => n + (i.type === 'mark' ? 1 : i.marks.length), 0);
    expect(inside).toBe(pm.marks.filter((m) => m.row.atMs >= at(13, 40) && m.row.atMs <= at(14, 40)).length);
  });
});

describe('snapping and keys', () => {
  const day = dayOf(
    laneOf(PM, [
      row({ project: PM, key: 'a', id: '1', atMs: at(9, 0) }),
      row({ project: PM, key: 'a', id: '2', atMs: at(10, 0) }),
      row({ project: PM, key: 'a', id: '3', atMs: at(12, 0) }),
    ]),
    laneOf(SITE, [row({ project: SITE, key: 'b', id: '1', atMs: at(9, 30) }), row({ project: SITE, key: 'b', id: '2', atMs: at(11, 0) })]),
  );
  const lanes = buildLanes(day);
  const pm = lanes.find((l) => l.project === PM)!;

  it('snaps to the nearest mark at or before the pointer, else the first', () => {
    expect(snapMark(pm.marks, at(10, 0))!.row.id).toBe('2');
    expect(snapMark(pm.marks, at(11, 59))!.row.id).toBe('2');
    expect(snapMark(pm.marks, at(12, 1))!.row.id).toBe('3');
    expect(snapMark(pm.marks, at(8, 0))!.row.id).toBe('1');
    expect(snapMark([], at(8, 0))).toBeNull();
  });

  it('walks marks in time order across all lanes with left and right', () => {
    const order = markOrder(lanes);
    expect(order.map((m) => `${m.row.key}${m.row.id}`)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
    expect(stepMark(order, 'nothing', 1)!.row.id).toBe('1');
    expect(stepMark(order, order[1].id, 1)!.id).toBe(order[2].id);
    expect(stepMark(order, order[1].id, -1)!.id).toBe(order[0].id);
    expect(stepMark(order, order[0].id, -1)!.id).toBe(order[0].id);
    expect(stepMark(order, order[4].id, 1)!.id).toBe(order[4].id);
    expect(stepMark([], null, 1)).toBeNull();
  });

  it('changes lane with up and down, to the mark closest in time', () => {
    const order = markOrder(lanes);
    const a2 = order[2];
    const down = stepLane(lanes, a2, 1)!;
    expect(down.lane).toBe(a2.lane + 1);
    expect(down.row.id).toBe('1');
    expect(stepLane(lanes, a2, -1)).toBe(a2);
    expect(stepLane(lanes, null, 1)).toBeNull();
  });
});

describe('labels', () => {
  it('pins the words a screen reader hears', () => {
    const day = dayOf(
      laneOf(PM, [
        row({ project: PM, key: 'a', id: '1', atMs: at(14, 8), turn: 7, files: 12 }),
        row({ project: PM, key: 'a', id: '2', atMs: at(14, 9), turn: 8, files: 1 }),
        row({ project: PM, key: 'day', id: '1', atMs: at(14, 40), kind: 'undo', agentType: '' }),
        row({ project: PM, key: 'a', id: '3', atMs: at(14, 50), kind: 'stop' }),
        row({ project: PM, key: 'a', id: '4', atMs: at(9, 0), turn: 1, files: 2, gone: true }),
      ]),
    );
    const marks = buildLanes(day)[0].marks;
    const byId = (id: string, key = 'a') => marks.find((m) => m.row.id === id && m.row.key === key)!;
    expect(markLabel(byId('1'), 'pm-workspace', 'Claude', t)).toBe('14:08, pm-workspace, Claude, turn 7, 12 files');
    expect(markLabel(byId('2'), 'pm-workspace', 'Claude', t)).toBe('14:09, pm-workspace, Claude, turn 8, 1 file');
    expect(markLabel(byId('1', 'day'), 'pm-workspace', '', t)).toBe('14:40, pm-workspace, went back');
    expect(markLabel(byId('3'), 'pm-workspace', 'Claude', t)).toBe('14:50, pm-workspace, Claude, stopped');
    expect(markLabel(byId('4'), 'pm-workspace', 'Claude', t)).toBe('09:00, pm-workspace, Claude, turn 1, 2 files, too old to go back to');
  });
});
