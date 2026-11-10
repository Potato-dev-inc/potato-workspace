import '../styles/switch-overlay.css';
import { runSwitch } from '../lib/mode-switch/animate';
import { collectProxies } from '../lib/mode-switch/collect';
import { motionFor, totalMs, type Direction, type Monitor, type SwitchStyle } from '../lib/mode-switch/model';

/**
 * Evidence only: draws the real switch overlay (the same `runSwitch` the overlay window runs) on top of the harness
 * cockpit, with proxies whose START rects are read from the cockpit's real DOM (`collectProxies`), and freezes it
 * at `at` (0..1) of its length by setting `currentTime`. The window rects are a made-up cascade on the right.
 */
export async function showSwitchFrame(opts: { style: SwitchStyle; at: number; direction?: Direction }): Promise<number> {
  const monitor: Monitor = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, scale: 1 };
  const ids = [...document.querySelectorAll<HTMLElement>('[data-pane-row]')].map((n) => n.dataset.paneRow!).filter(Boolean);
  const active = document.querySelector<HTMLElement>('[data-pane-tile]')?.dataset.paneTile ?? ids[0] ?? null;
  const windows = ids.map((id, i) => ({
    id,
    rect: { x: monitor.w * (0.3 + i * 0.045), y: monitor.h * (0.16 + i * 0.075), w: monitor.w * 0.36, h: monitor.h * 0.52 },
  }));
  const motion = motionFor(opts.style, false);
  const proxies = collectProxies({
    root: document,
    windows,
    activeId: active,
    origin: { x: 0, y: 0 },
    dpr: 1,
    monitor,
    describe: (id) => {
      const row = document.querySelector<HTMLElement>(`[data-pane-row="${id}"]`);
      const title = row?.querySelector('.ck-row-title')?.textContent ?? id;
      const project = row?.closest('.ck-proj')?.getAttribute('aria-label') ?? '';
      return { name: title, project, status: 'idle' };
    },
  });
  const total = totalMs(motion, proxies.length);
  const host = document.createElement('div');
  host.className = 'swo';
  host.style.zIndex = '99999';
  document.body.appendChild(host);
  document.documentElement.classList.add('swo-preview');
  const running = runSwitch(host, {
    gen: 0,
    direction: opts.direction ?? 'individual',
    motion,
    monitor,
    proxies,
    miniBar: { x: monitor.w * 0.31, y: 8, w: monitor.w * 0.38, h: 44 },
    totalMs: total,
  });
  const t = Math.round(total * opts.at);
  for (const a of running.animations) {
    a.pause();
    a.currentTime = t;
  }
  return proxies.length;
}
