import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import '../../styles/switch-overlay.css';
import { loadSettings } from '../../lib/settings';
import { runSwitch, type Running } from '../../lib/mode-switch/animate';
import { expectedMs, holdMs, prefersReducedMotion, proxyReport } from '../../lib/mode-switch/model';
import { previewSpec } from '../../lib/mode-switch/preview';
import { OVERLAY_CANCEL_EVENT, OVERLAY_PREVIEW_EVENT, OVERLAY_RUN_EVENT, type OverlayPreview, type OverlayRun } from '../../lib/mode-switch/protocol';

const frames = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
  window.setTimeout(resolve, 100 * n);
});
const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const tell = (command: 'switch_overlay_ready' | 'switch_overlay_done', gen: number, info?: Record<string, unknown>) =>
  void invoke(command, { gen, info: info ?? null }).catch(() => undefined);

/** The page background as the webview sees it right now: the first thing to check when the overlay is not see-through. */
function backgroundProbe(): Record<string, string> {
  const color = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : 'none');
  return { html: color(document.documentElement), body: color(document.body), root: color(document.getElementById('root')) };
}

/**
 * The switch overlay (`index.html?switchoverlay=1`): a transparent, click-through window over one monitor. Rust shows it,
 * sends `switch-overlay://run` with the proxies, and hides it again. It only draws; it never decides anything.
 */
export default function SwitchOverlayApp(): JSX.Element {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('swo-root');
    void loadSettings().catch(() => undefined);
    let current: { token: number; running: Running } | null = null;
    let token = 0;
    const stop = () => {
      token += 1;
      current?.running.cancel();
      current = null;
    };
    const start = (spec: OverlayRun, autoplay = true): { token: number; running: Running } | null => {
      if (!box.current) return null;
      stop();
      const mine = { token, running: runSwitch(box.current, spec, { autoplay }) };
      current = mine;
      return mine;
    };
    const offs: Array<() => void> = [];
    let disposed = false;
    const sub = (event: string, cb: (payload: never) => void) =>
      void listen(event, (e) => cb(e.payload as never)).then((off) => (disposed ? off() : offs.push(off)));

    sub(OVERLAY_RUN_EVENT, (spec: OverlayRun) => {
      // Paused on the first frame until Rust has been told: it times the end of the motion from "ready".
      const mine = start(spec, false);
      if (!mine) return;
      void (async () => {
        await frames(2);
        if (mine.token !== token) return;
        const expected = expectedMs(spec);
        tell('switch_overlay_ready', spec.gen, {
          reducedMotion: prefersReducedMotion(),
          motion: spec.motion,
          direction: spec.direction,
          expectedMs: expected,
          proxies: proxyReport(spec),
          viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
          visibility: document.visibilityState,
          background: backgroundProbe(),
        });
        const t0 = performance.now();
        mine.running.play();
        await mine.running.finished;
        if (mine.token !== token) return;
        // Every animation can report finished at once (a page that was not rendering, a clock that jumped): the motion
        // still lasts its time, so hold the "done" until it could have ended.
        const reported = performance.now() - t0;
        const held = holdMs(expected, reported);
        if (held > 0) await pause(held);
        if (mine.token === token) {
          tell('switch_overlay_done', spec.gen, { elapsedMs: Math.round(performance.now() - t0), reportedMs: Math.round(reported), heldMs: held, expectedMs: expected });
        }
      })();
    });
    sub(OVERLAY_CANCEL_EVENT, () => stop());
    sub(OVERLAY_PREVIEW_EVENT, (req: OverlayPreview) => {
      void (async () => {
        const reduced = prefersReducedMotion();
        const fwd = start(previewSpec(req.style, req.monitor, reduced, 'individual'));
        if (!fwd) return;
        await frames(2);
        await fwd.running.finished;
        await pause(450);
        if (fwd.token !== token) return;
        const back = start(previewSpec(req.style, req.monitor, reduced, 'orchestration'));
        if (!back) return;
        await back.running.finished;
        if (back.token === token) tell('switch_overlay_done', 0);
      })();
    });
    return () => {
      disposed = true;
      stop();
      offs.forEach((off) => off());
      document.documentElement.classList.remove('swo-root');
    };
  }, []);

  return <div className="swo" ref={box} aria-hidden="true" />;
}
