// A friendly name for this phone, made from what the browser says about it (the user agent, and Client Hints when the
// browser gives them: `navigator.userAgentData.getHighEntropyValues(['model'])`). It is told to the PC when the phone pairs
// and again when it changes, so a chat can say "from OPPO Reno13". The person can rename it on the PC; their name wins.
// No login and nothing secret: a model name only.

/** Brand for a model code's first letters, when the code alone would mean nothing to a person. Longest prefix wins. */
const CODE_BRANDS: readonly [string, string][] = [
  ['SM-', 'Samsung'],
  ['GT-', 'Samsung'],
  ['CPH', 'OPPO'],
  ['PGJ', 'OPPO'],
  ['RMX', 'realme'],
  ['V2', 'vivo'],
  ['2201', 'Xiaomi'],
  ['M20', 'Xiaomi'],
  ['23', 'Xiaomi'],
  ['LE2', 'OnePlus'],
  ['IN20', 'Micromax'],
  ['XQ-', 'Sony'],
  ['ASUS_', 'ASUS'],
];

/** Marketing names for model codes can be added here (code -> name). None is shipped: a wrong guess is worse than the code. */
const KNOWN_MODELS: Record<string, string> = {};

const BRAND_WORDS = /^(samsung|google|pixel|oppo|vivo|xiaomi|redmi|poco|oneplus|realme|huawei|honor|sony|motorola|moto|nokia|asus|lenovo|nothing)\b/i;

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** The model of an Android phone as the user agent says it ("Linux; Android 14; CPH2689 Build/..."), or null. */
export function modelFromUserAgent(ua: string): string | null {
  const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*(?:;|\))/i.exec(ua);
  const model = m?.[1]?.trim();
  if (!model || /^(K|Mobile|Linux|wv)$/i.test(model)) return null;
  return model;
}

/** A name a person recognises, from a model string ("CPH2689", "Pixel 9", "SM-S918B"). */
export function nameForModel(model: string): string {
  const clean = tidy(model);
  if (KNOWN_MODELS[clean]) return KNOWN_MODELS[clean];
  if (BRAND_WORDS.test(clean)) return clean.replace(/^pixel\b/i, 'Google Pixel').replace(/^google google/i, 'Google');
  const brand = [...CODE_BRANDS].sort((a, b) => b[0].length - a[0].length).find(([prefix]) => clean.toUpperCase().startsWith(prefix));
  return brand && /\d/.test(clean) ? `${brand[1]} ${clean}` : clean;
}

export interface NameHints {
  /** Client Hints `model` (empty on most desktops and on iPhone). */
  model?: string | null;
  /** Client Hints `platform` ("Android", "Windows", "macOS"). */
  platform?: string | null;
}

/** The friendly name from the user agent and, when there are any, Client Hints. Always something. */
export function friendlyPhoneName(ua: string, hints: NameHints = {}): string {
  const hinted = hints.model?.trim();
  if (hinted) return nameForModel(hinted);
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) {
    const model = modelFromUserAgent(ua);
    return model ? nameForModel(model) : 'Android phone';
  }
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Mobile device';
}

interface UserAgentData {
  getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string; platform?: string }>;
}

/** The name as best the browser can say it now (Client Hints are asked for; a browser without them uses the user agent). */
export async function readPhoneName(nav: Pick<Navigator, 'userAgent'> & { userAgentData?: UserAgentData } = navigator): Promise<string> {
  let hints: NameHints = {};
  try {
    const high = await nav.userAgentData?.getHighEntropyValues?.(['model', 'platform']);
    if (high) hints = { model: high.model, platform: high.platform };
  } catch {
    // The browser refused the hints: the user agent is enough.
  }
  return friendlyPhoneName(nav.userAgent, hints);
}
