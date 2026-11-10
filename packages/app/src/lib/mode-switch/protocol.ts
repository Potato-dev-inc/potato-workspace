// What Rust, the cockpit and the switch overlay say to each other during an animated mode switch.
// Rust drives the switch and works without the cockpit or the overlay answering (it times out and finishes
// the switch instantly); these messages only make it pretty.
import type { Direction, MotionStyle, Monitor, ProxySpec, Rect, RunSpec, SwitchStyle } from './model';

export const SWITCH_EVENT = 'ui://mode-switch';
export const OVERLAY_RUN_EVENT = 'switch-overlay://run';
export const OVERLAY_CANCEL_EVENT = 'switch-overlay://cancel';
export const OVERLAY_PREVIEW_EVENT = 'switch-overlay://preview';

/** A pane's pop-out window: where it will open (to Individual) or where it is (coming back). Physical screen px. */
export interface WindowRect {
  id: string;
  rect: Rect;
}

/** What `plan_mode_switch` answers: the pop-out rect of every pane that gets a window, and the mini bar. */
export interface ModeSwitchPlan {
  windows: WindowRect[];
  miniBar: Rect | null;
  monitor: Monitor | null;
}

/** Rust -> cockpit (`ui://mode-switch`). */
export type SwitchEvent =
  /** Coming back: the cockpit is about to be shown. Make its content invisible first. */
  | { phase: 'hold'; gen: number }
  /** Collect the proxies and answer with `mode_switch_begin`. `origin` is where the cockpit's client area sits on screen. */
  | {
      phase: 'prepare';
      gen: number;
      direction: Direction;
      style: SwitchStyle;
      monitor: Monitor;
      origin: { x: number; y: number };
      windows: WindowRect[];
      miniBar: Rect | null;
    }
  /** The switch is over (done, timed out or cancelled): drop every temporary look. */
  | { phase: 'finish'; gen: number };

/** Cockpit -> Rust (`mode_switch_begin`). No proxies means nothing to animate: Rust switches at once. */
export interface BeginSpec {
  motion: MotionStyle;
  totalMs: number;
  proxies: ProxySpec[];
}

export type OverlayRun = RunSpec;

/** Rust -> overlay (`switch-overlay://preview`): play a demo over the middle of the screen. */
export interface OverlayPreview {
  style: SwitchStyle;
  /** Physical px of the monitor to draw on. */
  monitor: Monitor;
}
