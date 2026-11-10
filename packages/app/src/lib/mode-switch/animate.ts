// Draws the mode-switch motion into a container with the Web Animations API. Used by the switch overlay window
// (a transparent, click-through window over the monitor) and by the evidence preview. No Tauri here.
import { faceFade, keyframes, timing, toLocal, FADE_MS, type Face, type MotionStyle, type ProxySpec, type RunSpec } from './model';

export interface Running {
  /** Every animation that was started (the preview scrubs them). */
  animations: Animation[];
  /** Resolves when the last one has finished (or was cancelled). */
  finished: Promise<void>;
  /** Start the motion (only needed after `runSwitch(..., { autoplay: false })`). */
  play: () => void;
  /** Stop and remove everything at once. */
  cancel: () => void;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const LINE_WIDTHS = [80, 100, 60, 90, 40];

/** The window face: title bar, name and project, a few placeholder lines. */
function windowFace(face: Extract<Face, { kind: 'simple' }>): HTMLElement {
  const root = el('div', 'swo-winface');
  const bar = el('div', 'swo-bar');
  for (let i = 0; i < 3; i++) bar.appendChild(el('i', 'swo-dot'));
  root.appendChild(bar);
  root.appendChild(el('div', 'swo-name', face.project ? `${face.name} · ${face.project}` : face.name));
  const lines = el('div', 'swo-lines');
  LINE_WIDTHS.forEach((w) => {
    const line = el('i', 'swo-line');
    line.style.width = `${w}%`;
    lines.appendChild(line);
  });
  root.appendChild(lines);
  return root;
}

function snapshotFace(src: string): HTMLElement {
  const img = document.createElement('img');
  img.className = 'swo-snap';
  img.src = src;
  img.alt = '';
  img.draggable = false;
  return img;
}

function rowFace(name: string, status: string): HTMLElement {
  const root = el('div', 'swo-rowface');
  const dot = el('span', `swo-rowdot swo-rowdot--${status || 'idle'}`);
  root.appendChild(dot);
  root.appendChild(el('span', 'swo-rowname', name));
  return root;
}

function buildProxy(spec: ProxySpec): { node: HTMLElement; row: HTMLElement | null; win: HTMLElement } {
  const node = el('div', 'swo-proxy');
  node.dataset.pane = spec.id;
  const win = spec.face.kind === 'snapshot' ? snapshotFace(spec.face.src) : windowFace(spec.face);
  let row: HTMLElement | null = null;
  if (spec.fromRow) {
    node.classList.add('is-row');
    row = rowFace(spec.face.kind === 'simple' ? spec.face.name : '', spec.face.kind === 'simple' ? spec.face.status : '');
    win.style.opacity = '0';
    node.appendChild(row);
  }
  node.appendChild(win);
  return { node, row, win };
}

const ROW_LOOK = { background: 'var(--swo-row)', borderColor: 'transparent', boxShadow: 'none' };
const WIN_LOOK = { background: 'var(--swo-win)', borderColor: 'var(--swo-line)', boxShadow: 'var(--swo-shadow)' };

/**
 * Start the motion of `spec` inside `root` (the container covers the monitor `spec.monitor`).
 * The first frame of every proxy is already in place (`fill: both`), so a delayed proxy waits at its start.
 * With `autoplay: false` everything waits there, paused, until `play()`: the overlay reports "ready" first and
 * starts the clock after, so Rust times the end of the motion from that moment.
 */
export function runSwitch(root: HTMLElement, spec: RunSpec, opts: { autoplay?: boolean } = {}): Running {
  const reverse = spec.direction === 'orchestration';
  const n = spec.proxies.length;
  const animations: Animation[] = [];
  const nodes: HTMLElement[] = [];
  const motion: MotionStyle = spec.motion;
  const direction: PlaybackDirection = reverse ? 'reverse' : 'normal';

  spec.proxies.forEach((proxy, i) => {
    const { node, row, win } = buildProxy(proxy);
    root.appendChild(node);
    nodes.push(node);
    const a = toLocal(proxy.start, spec.monitor);
    const b = toLocal(proxy.end, spec.monitor);
    const t = timing(motion, i, n, reverse);
    animations.push(node.animate(keyframes(motion, a, b, i) as Keyframe[], { ...t, direction, fill: 'both' }));
    if (row && motion !== 'fade') {
      const f = faceFade(t.duration, t.delay, reverse);
      const opts = { ...f, direction, fill: 'both' as const };
      animations.push(row.animate([{ opacity: 1 }, { opacity: 0 }], opts));
      animations.push(win.animate([{ opacity: 0 }, { opacity: 1 }], opts));
      animations.push(node.animate([ROW_LOOK, WIN_LOOK], { duration: t.duration, delay: t.delay, easing: 'ease-in-out', direction, fill: 'both' }));
    } else if (row) {
      // Fade: nothing travels, the window face is simply there.
      win.style.opacity = '1';
      row.style.display = 'none';
    }
  });

  if (spec.miniBar) {
    const pill = el('div', 'swo-minibar');
    const box = toLocal(spec.miniBar, spec.monitor);
    Object.assign(pill.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    root.appendChild(pill);
    nodes.push(pill);
    const from = reverse ? 1 : 0;
    const delay = reverse ? 0 : Math.max(0, spec.totalMs - FADE_MS);
    animations.push(pill.animate([{ opacity: from }, { opacity: 1 - from }], { duration: FADE_MS, delay, fill: 'both' }));
  }

  if (opts.autoplay === false) animations.forEach((a) => a.pause());
  const play = () => animations.forEach((a) => a.play());

  const finished = Promise.all(animations.map((a) => a.finished.then(() => undefined, () => undefined))).then(() => undefined);
  const cancel = () => {
    animations.forEach((a) => {
      try {
        a.cancel();
      } catch {
        /* already gone */
      }
    });
    nodes.forEach((node) => node.remove());
  };
  return { animations, finished, play, cancel };
}
