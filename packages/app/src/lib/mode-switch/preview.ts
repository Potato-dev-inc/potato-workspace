// A demo run for Settings > "Preview" and the evidence screenshots: five panes (three on a grid, two from the
// sidebar) fly to five windows over the middle of a monitor. Pure; the geometry is a fraction of the monitor.
import { motionFor, totalMs, type Monitor, type ProxySpec, type Rect, type RunSpec, type SwitchStyle } from './model';

const NAMES: Array<{ name: string; project: string }> = [
  { name: 'Claude', project: 'pm-workspace' },
  { name: 'OpenCode', project: 'pm-workspace' },
  { name: 'Codex', project: 'potato-bot' },
  { name: 'Claude 2', project: 'potato-bot' },
  { name: 'Cursor', project: 'site' },
];

const frac = (m: Monitor, x: number, y: number, w: number, h: number): Rect => ({ x: m.x + m.w * x, y: m.y + m.h * y, w: m.w * w, h: m.h * h });

export function previewSpec(style: SwitchStyle, monitor: Monitor, reducedMotion: boolean, direction: RunSpec['direction'] = 'individual'): RunSpec {
  const motion = motionFor(style, reducedMotion);
  const tiles: Array<Rect | null> = [frac(monitor, 0.2, 0.12, 0.39, 0.4), frac(monitor, 0.6, 0.12, 0.39, 0.4), frac(monitor, 0.2, 0.55, 0.79, 0.4), null, null];
  const rows: Rect[] = [0, 1, 2, 3, 4].map((i) => frac(monitor, 0.015, 0.14 + i * 0.045, 0.16, 0.034));
  const pops: Rect[] = [0, 1, 2, 3, 4].map((i) => frac(monitor, 0.04 + i * 0.17, 0.22 + i * 0.06, 0.26, 0.46));
  const proxies: ProxySpec[] = NAMES.map((n, i) => ({
    id: `preview-${i}`,
    start: tiles[i] ?? rows[i],
    end: pops[i],
    face: { kind: 'simple', name: n.name, project: n.project, status: i === 0 ? 'running' : 'idle' },
    fromRow: tiles[i] === null,
  }));
  return {
    gen: 0,
    direction,
    motion,
    monitor,
    proxies,
    miniBar: frac(monitor, 0.31, 0.01, 0.38, 0.04),
    totalMs: totalMs(motion, proxies.length),
  };
}
