// The shapes of "Leaving my desk" (kept apart from the store so `tauri.ts` can name them without a cycle).
export type DeskLength = 'until_back' | 'one_hour' | 'four_hours' | 'tonight';
export const DESK_LENGTHS: readonly DeskLength[] = ['until_back', 'one_hour', 'four_hours', 'tonight'];

export interface DeskAway {
  away: boolean;
  length?: DeskLength;
  started_ms?: number;
  /** `null` while "until I'm back" runs. */
  until_ms?: number | null;
  /** Who flipped it: the PC lifts what phones may do, a phone's own switch does not. */
  by?: 'pc' | 'phone';
  lock_screen: boolean;
  device_name?: string | null;
  /** How many phones are paired. */
  phones: number;
}

export const NOT_AWAY: DeskAway = { away: false, lock_screen: false, phones: 0 };
