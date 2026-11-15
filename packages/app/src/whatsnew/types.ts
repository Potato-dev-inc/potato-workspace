// What's new: the shape of a highlight (one card of the tour, one card of the Feature guide). Design: WHATSNEW-1116.
export const AREAS = ['Chat', 'Agents', 'Files', 'Team', 'Phone', 'Look'] as const;
export type Area = (typeof AREAS)[number];
export type Platform = 'desktop' | 'phone';

/** The closed list of things "Try it" may do. Never a URL or free text. */
export const ACTION_NAMES = ['rail.open', 'split.hint', 'standby.new', 'artifact.sample', 'files.sample', 'settings.open', 'chat.viewMenu', 'view.open', 'usage.open', 'point.start'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export interface Highlight {
  /** Unique for ever: the key for "seen" and for tests. */
  id: string;
  /** The version that added it. Absent in a version's own file: the file's version. */
  since?: string;
  title: string;
  line: string;
  area: Area;
  demo: string;
  /** true: in the tour (3 to 6 per version); false: only in the Feature guide. */
  tour: boolean;
  tryLabel: string;
  try: { action: ActionName; args?: Record<string, unknown> };
  platforms?: Platform[];
  /** A Labs switch key: the card is hidden while it is off. */
  labs?: string | null;
}

export interface HighlightsFile {
  version: string;
  date: string;
  highlights: Highlight[];
}

export const TITLE_MAX = 32;
export const LINE_MAX = 90;
export const TOUR_MIN = 3;
export const TOUR_MAX = 6;
