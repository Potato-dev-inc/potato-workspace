// Comfort settings (Settings > Look and feel): text size, strong contrast, less motion, spoken results.
// Pure: no DOM and no storage here. The store (store.ts) saves them, root.ts puts them on the page.

/** Text size steps the person can pick, in percent. 100 is the app's normal size. */
export const TEXT_SCALES = [90, 100, 110, 120, 130, 140] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

export interface ComfortPrefs {
  textScale: TextScale;
  strongContrast: boolean;
  lessMotion: boolean;
  speakResults: boolean;
}

export const COMFORT_DEFAULTS: ComfortPrefs = { textScale: 100, strongContrast: false, lessMotion: false, speakResults: false };

/** The browser-storage key (this computer only). */
export const COMFORT_KEY = 'potato.comfort.v1';

/** The nearest allowed text size to a value (anything not a number is the normal 100). */
export function clampTextScale(value: unknown): TextScale {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return COMFORT_DEFAULTS.textScale;
  let best: TextScale = COMFORT_DEFAULTS.textScale;
  let bestDistance = Infinity;
  for (const step of TEXT_SCALES) {
    const distance = Math.abs(step - n);
    if (distance < bestDistance) {
      best = step;
      bestDistance = distance;
    }
  }
  return best;
}

/** One step bigger (+1), one step smaller (-1), or back to 100 (0). Stops at the ends. */
export function stepTextScale(current: TextScale, direction: 1 | -1 | 0): TextScale {
  if (direction === 0) return COMFORT_DEFAULTS.textScale;
  const index = TEXT_SCALES.indexOf(current);
  const next = Math.min(TEXT_SCALES.length - 1, Math.max(0, index + direction));
  return TEXT_SCALES[next];
}

/** Any stored value back to a full set of prefs; a missing or odd field takes its default. */
export function parseComfort(raw: unknown): ComfortPrefs {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    textScale: clampTextScale(source.textScale),
    strongContrast: source.strongContrast === true,
    lessMotion: source.lessMotion === true,
    speakResults: source.speakResults === true,
  };
}

/** Less motion is on when the person picked it, or Windows (or the browser) asks for reduced motion. */
export function reducedMotion(prefs: ComfortPrefs, systemReduce: boolean): boolean {
  return prefs.lessMotion || systemReduce;
}

/** The root scale as a number for CSS: 90% is 0.9. */
export function scaleFactor(prefs: ComfortPrefs): number {
  return prefs.textScale / 100;
}
