// The Today page (Labs `timeline_day_enabled`, off by default): one line for the whole day, every chat and
// project, and a way to go back to any point on it. Rust: `timeline/`. Nothing user-visible may appear
// while the flag is off; the sidebar entry calls `useTimelineEnabled()` and renders nothing.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import type { BridgeClient } from './bridge-types';
import { bridgeRefusalText } from './paneOutbox-bridge';
import { loadSettings } from './settings';

export const TIMELINE_LABS_KEY = 'timeline_day_enabled' as const;

export function timelineEnabled(settings: { timeline_day_enabled?: boolean } | null | undefined): boolean {
  return settings?.timeline_day_enabled === true;
}

export function useTimelineEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void loadSettings().then(
      (settings) => {
        if (live) setOn(timelineEnabled(settings));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/** One save point on the line (Rust `timeline::RowView`). */
export interface TimelineRow {
  atMs: number;
  /** The folder the point is of. */
  project: string;
  /** The series: a chat's key, `day`, `mission-<id>` or `wb-<id>`. */
  key: string;
  id: string;
  tree: string;
  /** `before`, `after`, `answer`, `stop` or `undo`. */
  kind: string;
  turn: number;
  files: number;
  added: number;
  deleted: number;
  agentType: string;
  chatId: string;
  chatTitle: string;
  note: string;
  viaPhone: boolean;
  /** The save point is gone: drawn faded. */
  gone: boolean;
  /** A mission or "What broke it" step. */
  helper: boolean;
}

export interface TimelineLane {
  project: string;
  name: string;
  folderGone: boolean;
  /** Oldest first. */
  rows: TimelineRow[];
  lastMs: number;
}

export interface TimelineDay {
  date: string;
  today: string;
  nowMs: number;
  /** Newest activity first. */
  lanes: TimelineLane[];
  /** Days with a journal, newest first. */
  dates: string[];
}

export interface PointFile {
  path: string;
  status: 'A' | 'M' | 'D' | string;
  added: number;
  deleted: number;
  binary: boolean;
}

/** What going back to a point would change (status is from the point of view of going back). */
export interface NowDiff {
  files: PointFile[];
  total: number;
  changed: number;
  restored: number;
  removed: number;
  more: number;
  /** The folder has its own git. */
  hasGit: boolean;
}

export interface GoBackReport {
  safetyId: string | null;
  written: number;
  removed: number;
  failed: string[];
}

export interface PointRef {
  project: string;
  key: string;
  id: string;
}

export interface TimelineApi {
  day: (date: string) => Promise<TimelineDay>;
  pointDiff: (p: PointRef) => Promise<PointFile[]>;
  nowDiff: (p: PointRef) => Promise<NowDiff>;
  /** `side` `"now"`: what going back would do to the file; else what the turn did. */
  filePatch: (p: PointRef, path: string, side?: 'now' | 'turn') => Promise<{ patch: string; truncated: boolean }>;
  goBack: (p: PointRef) => Promise<GoBackReport>;
}

export const timelineApi: TimelineApi = {
  day: (date) => invoke<TimelineDay>('timeline_day', { date }),
  pointDiff: (p) => invoke<PointFile[]>('timeline_point_diff', { ...p }),
  nowDiff: (p) => invoke<NowDiff>('timeline_now_diff', { ...p }),
  filePatch: async (p, path, side = 'turn') => {
    const [patch, truncated] = await invoke<[string, boolean]>('timeline_file_patch', { ...p, path, side });
    return { patch, truncated };
  },
  goBack: (p) => invoke<GoBackReport>('timeline_go_back', { ...p }),
};

/** Local `YYYY-MM-DD` for a time. Matches the date Rust names the day file with. */
export function dateOfMs(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The day before or after a `YYYY-MM-DD` date. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return dateOfMs(new Date(y, m - 1, d + days, 12).getTime());
}

/**
 * The phone's copy: the `/timeline` routes of the PC (the same data and the same one write). An old PC without them
 * gets a plain sentence; a refused call reads as the PC's own sentence, so the page can turn it into the reason.
 */
export function bridgeTimelineApi(bridge: BridgeClient): TimelineApi {
  const old = 'This PC is too old to show your day on the phone.';
  const guard = async <T>(run: (() => Promise<T>) | null, fallback: string): Promise<T> => {
    if (!run) throw new Error(old);
    try {
      return await run();
    } catch (error) {
      throw new Error(bridgeRefusalText(error, fallback));
    }
  };
  return {
    day: (date) => guard(bridge.timelineDay ? () => bridge.timelineDay!(date) : null, 'Could not load your day.'),
    pointDiff: (p) => guard(bridge.timelinePointDiff ? () => bridge.timelinePointDiff!(p) : null, 'Could not load this point.'),
    nowDiff: (p) => guard(bridge.timelineNowDiff ? () => bridge.timelineNowDiff!(p) : null, 'Could not load this point.'),
    filePatch: (p, path, side = 'turn') => guard(bridge.timelinePatch ? () => bridge.timelinePatch!(p, path, side) : null, 'Could not load this file.'),
    goBack: (p) => guard(bridge.timelineGoBack ? () => bridge.timelineGoBack!(p) : null, 'Could not go back.'),
  };
}
