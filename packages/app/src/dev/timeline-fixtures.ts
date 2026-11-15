// A believable day for the Today page: 3 projects (one with a helper's worktree), 4 agents, about 120 marks, a lunch
// gap, a busy stretch, a pruned stretch, one mission step and one go-back. Deterministic: no clock, no randomness
// beyond a fixed seed. Used by the screen tests, the dev scenarios and the mocked Tauri commands.
import type { NowDiff, PointFile, TimelineDay, TimelineLane, TimelineRow } from '../lib/timeline';

/** Sat 15 Nov 2026, 15:30 local. */
export const FIXTURE_NOW = new Date(2026, 10, 15, 15, 30).getTime();
export const FIXTURE_DATE = '2026-11-15';

const at = (h: number, m: number) => new Date(2026, 10, 15, h, m).getTime();

export const PM = 'C:/work/pm-workspace';
export const SITE = 'C:/work/potato-site';
export const NOTES = 'C:/work/notes';
export const WORKTREE = 'C:/work/pm-workspace/.worktrees/helper-1';

const PROMPTS = [
  'Fix the split view drag',
  'Make the sidebar remember its width',
  'Add a test for the retry button',
  'Rename the helper to assistant',
  'Why is the build slow?',
  'Clean up the settings page',
  'Tidy the changelog',
  'Handle an empty folder',
  'Speed up the file search',
  'Fix the typo in the welcome text',
];

export function row(partial: Partial<TimelineRow> & Pick<TimelineRow, 'project' | 'key' | 'id' | 'atMs'>): TimelineRow {
  return {
    tree: `tree-${partial.key}-${partial.id}`,
    kind: 'after',
    turn: 1,
    files: 3,
    added: 20,
    deleted: 4,
    agentType: 'claude',
    chatId: partial.key,
    chatTitle: '',
    note: '',
    viaPhone: false,
    gone: false,
    helper: false,
    ...partial,
  };
}

function lane(project: string, rows: TimelineRow[], folderGone = false): TimelineLane {
  const name = project.split('/').pop() ?? project;
  return { project, name, folderGone, rows, lastMs: Math.max(0, ...rows.map((r) => r.atMs)) };
}

/** A small deterministic generator (fixed seed), so the same day comes out every time. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function series(project: string, key: string, agentType: string, times: number[], startId: number, goneUntil: number, rand: () => number): TimelineRow[] {
  const out: TimelineRow[] = [];
  times.forEach((atMs, i) => {
    const files = rand() < 0.08 ? 0 : 1 + Math.floor(rand() * 14);
    out.push(
      row({
        project,
        key,
        id: String(startId + i * 2),
        atMs,
        turn: i + 1,
        agentType,
        chatTitle: `${key} chat`,
        note: PROMPTS[(i + startId) % PROMPTS.length],
        files,
        added: files * 7,
        deleted: files * 2,
        gone: i < goneUntil,
      }),
    );
  });
  return out;
}

/** Times in minutes since midnight, as local times of the fixture day. */
function spread(from: number, to: number, count: number, rand: () => number): number[] {
  const list: number[] = [];
  for (let i = 0; i < count; i++) list.push(Math.round(from + ((to - from) * (i + rand() * 0.6)) / count));
  return list.map((m) => at(Math.floor(m / 60), m % 60));
}

export function sampleDay(): TimelineDay {
  const rand = seeded(15);
  // pm-workspace: a morning, a busy stretch at 10:40, a long lunch, then an afternoon. The first ten points are pruned.
  const morning = spread(9 * 60, 10 * 60 + 30, 18, rand);
  const busy = Array.from({ length: 10 }, (_, i) => new Date(2026, 10, 15, 10, 40, i * 36).getTime());
  const beforeLunch = spread(10 * 60 + 55, 12 * 60, 14, rand);
  const afternoon = spread(13 * 60 + 30, 15 * 60 + 20, 30, rand);
  const pmTimes = [...morning, ...busy, ...beforeLunch, ...afternoon];
  const half = Math.floor(pmTimes.length / 2);
  const pmRows = [
    ...series(PM, 'claude-1', 'claude', pmTimes.slice(0, half), 1, 10, rand),
    ...series(PM, 'codex-1', 'codex', pmTimes.slice(half), 1, 0, rand),
  ];
  // The go-back at 14:40 (its safety copy, in the `day` series).
  pmRows.push(row({ project: PM, key: 'day', id: '1', atMs: at(14, 40), kind: 'undo', agentType: '', files: 5, turn: 0 }));
  // A mission's own step, hidden unless "Show helpers' own steps" is on.
  pmRows.push(row({ project: PM, key: 'mission-7', id: '1', atMs: at(11, 20), agentType: '', helper: true, files: 2 }));
  const worktreeRows = series(WORKTREE, 'helper-1', 'gemini', spread(14 * 60, 15 * 60, 4, rand), 1, 0, rand);
  const siteRows = series(SITE, 'opencode-1', 'opencode', [...spread(9 * 60 + 30, 11 * 60 + 40, 12, rand), ...spread(14 * 60, 15 * 60 + 10, 12, rand)], 1, 0, rand);
  const notesRows = series(NOTES, 'claude-2', 'claude', [at(11, 40), at(11, 52), at(12, 1)], 1, 0, rand);
  const lanes = [lane(PM, pmRows), lane(WORKTREE, worktreeRows), lane(SITE, siteRows), lane(NOTES, notesRows)];
  lanes.sort((a, b) => b.lastMs - a.lastMs);
  return { date: FIXTURE_DATE, today: FIXTURE_DATE, nowMs: FIXTURE_NOW, lanes, dates: [FIXTURE_DATE, '2026-11-14', '2026-11-13'] };
}

export const FIXTURE_TURN_FILES: PointFile[] = [
  { path: 'src/components/SplitView.tsx', status: 'M', added: 20, deleted: 3, binary: false },
  { path: 'src-tauri/src/split.rs', status: 'M', added: 120, deleted: 40, binary: false },
  { path: 'src/styles/split.css', status: 'A', added: 14, deleted: 0, binary: false },
  { path: 'docs/old-notes.md', status: 'D', added: 0, deleted: 8, binary: false },
];

export function sampleNowDiff(over: Partial<NowDiff> = {}): NowDiff {
  return {
    files: [
      { path: 'src/components/SplitView.tsx', status: 'M', added: 4, deleted: 9, binary: false },
      { path: 'src/styles/split.css', status: 'D', added: 0, deleted: 14, binary: false },
      { path: 'docs/old-notes.md', status: 'A', added: 8, deleted: 0, binary: false },
    ],
    total: 3,
    changed: 1,
    restored: 1,
    removed: 1,
    more: 0,
    hasGit: true,
    ...over,
  };
}

export const SAMPLE_PATCH = [
  'diff --git a/src/components/SplitView.tsx b/src/components/SplitView.tsx',
  '--- a/src/components/SplitView.tsx',
  '+++ b/src/components/SplitView.tsx',
  '@@ -10,4 +10,5 @@ export function SplitView() {',
  '   const [ratio, setRatio] = useState(0.5);',
  '-  const drag = useDrag();',
  '+  const drag = useDrag({ snap: true });',
  '+  const rect = useRef<DOMRect | null>(null);',
  '   return <div />;',
].join('\n');
