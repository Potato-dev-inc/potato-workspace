// The cockpit's part of an animated mode switch. Rust drives (see src-tauri/src/switch_anim); this hook answers
// `ui://mode-switch`: it collects the proxies (rects + faces), hands them to Rust, and gets the cockpit out of the
// way while the overlay window draws the motion. If anything here fails, Rust times out and switches at once.
import { useEffect, useRef } from 'react';
import '../../styles/mode-switch.css';
import { cockpitApi } from '../cockpit-api';
import { collectProxies, readPaneOrder, type PaneLabel } from './collect';
import { motionFor, prefersReducedMotion, totalMs, type MotionStyle } from './model';
import type { SwitchEvent } from './protocol';

const HOLD_SAFETY_MS = 4000;
const LAYOUT_WAIT_MS = 120;

type Html = HTMLElement;

function clearLook(): void {
  const html: Html = document.documentElement;
  html.classList.remove('sw-out', 'sw-hold', 'sw-in');
  document.querySelectorAll('[data-sw-hide]').forEach((n) => n.removeAttribute('data-sw-hide'));
}

/** Two frames for React to commit the tiles after the mode flip; a hidden window may not run frames, so a timeout backs it up. */
function layoutSettled(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    window.setTimeout(finish, LAYOUT_WAIT_MS);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

const ORDER_DEBOUNCE_MS = 250;

export function useModeSwitch(opts: { activeId: string | null; describe: (id: string) => PaneLabel }): void {
  const latest = useRef(opts);
  latest.current = opts;

  // Keep Rust told of the pane order (active first, then the open tiles, then the sidebar rows) for the side-by-side
  // layout. Only sends when it changed.
  useEffect(() => {
    let timer: number | undefined;
    let last = '';
    const send = () => {
      try {
        const ids = readPaneOrder(document, latest.current.activeId);
        const key = ids.join('\n');
        if (key === last) return;
        last = key;
        void cockpitApi.reportPaneOrder?.(ids)?.catch(() => undefined);
      } catch {
        /* the layout falls back to the registry order */
      }
    };
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(send, ORDER_DEBOUNCE_MS);
    };
    later();
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(later) : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      window.clearTimeout(timer);
    };
  }, [opts.activeId]);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    let safety: number | undefined;
    let fadeIn: number | undefined;
    const arm = () => {
      window.clearTimeout(safety);
      safety = window.setTimeout(clearLook, HOLD_SAFETY_MS);
    };

    const prepare = async (e: Extract<SwitchEvent, { phase: 'prepare' }>) => {
      const back = e.direction === 'orchestration';
      const motion: MotionStyle = motionFor(e.style, prefersReducedMotion());
      if (back) await layoutSettled();
      let proxies: ReturnType<typeof collectProxies> = [];
      try {
        proxies = collectProxies({
          root: document,
          windows: e.windows,
          activeId: latest.current.activeId,
          origin: e.origin,
          dpr: window.devicePixelRatio || 1,
          monitor: e.monitor,
          describe: latest.current.describe,
          snapshots: !back,
        });
      } catch {
        proxies = [];
      }
      const total = totalMs(motion, proxies.length);
      // Answer first: Rust starts the overlay on this, and the cockpit fades only once the proxies are up.
      await cockpitApi.modeSwitchBegin(e.gen, { motion, totalMs: total, proxies }).catch(() => undefined);
      if (!proxies.length) {
        if (!back) clearLook();
        return;
      }
      arm();
      if (back) {
        const ids = new Set(proxies.map((p) => p.id));
        document.querySelectorAll<HTMLElement>('[data-pane-tile]').forEach((n) => {
          if (n.dataset.paneTile && ids.has(n.dataset.paneTile)) n.setAttribute('data-sw-hide', '');
        });
        window.clearTimeout(fadeIn);
        fadeIn = window.setTimeout(() => document.documentElement.classList.add('sw-in'), Math.max(0, total - 140));
      } else {
        document.documentElement.classList.add('sw-out');
      }
    };

    void cockpitApi
      .onModeSwitch((e) => {
        if (disposed) return;
        if (e.phase === 'hold') {
          document.documentElement.classList.add('sw-hold');
          arm();
        } else if (e.phase === 'prepare') {
          void prepare(e);
        } else {
          window.clearTimeout(safety);
          window.clearTimeout(fadeIn);
          clearLook();
        }
      })
      .then((u) => (disposed ? u() : (off = u)));

    return () => {
      disposed = true;
      off?.();
      window.clearTimeout(safety);
      window.clearTimeout(fadeIn);
      clearLook();
    };
  }, []);
}
