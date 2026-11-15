// "Share to Potato" from any phone app (Web Share Target). The OS posts what the person shared (text, a link, pictures,
// files) to `/share-target`; the service worker keeps it in Cache Storage and sends the window to `/?share=1`, where the
// app reads it once and opens "New chat with this". Nothing is sent to the PC here: that waits for the person's Send.
// Pure: the cache storage is passed in, so it is tested with a fake one and compiles in the service-worker project too.

/** Where the manifest's `share_target` posts to. */
export const SHARE_PATH = '/share-target';
/** The launch URL after a share: the app finds the content in the cache. */
export const SHARE_LAUNCH = '/?share=1';
export const SHARE_CACHE = 'pm-share';
const META_KEY = '/__pm_share__';
const FILE_KEY = (index: number) => `/__pm_share_file_${index}__`;

/** What is kept: a share older than this is stale (the person opened the app some other way). */
export const SHARE_TTL_MS = 10 * 60_000;
/** Longest text kept per field (the message box takes about this much). */
export const SHARE_TEXT_MAX = 8000;
export const SHARE_MAX_FILES = 5;
export const SHARE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** The manifest entry (vite.config.ts uses it as is). */
export const SHARE_TARGET_MANIFEST = {
  action: SHARE_PATH,
  method: 'POST',
  enctype: 'multipart/form-data',
  params: {
    title: 'title',
    text: 'text',
    url: 'url',
    files: [{ name: 'media', accept: ['image/*', 'application/pdf', 'text/*'] }],
  },
} as const;

export interface SharedContent {
  title: string;
  text: string;
  url: string;
  files: File[];
}

/** The slice of Cache Storage this needs. */
export interface ShareCaches {
  open(name: string): Promise<{
    put(key: string, response: Response): Promise<void>;
    match(key: string): Promise<Response | undefined>;
    delete(key: string): Promise<boolean>;
  }>;
}

const clip = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, SHARE_TEXT_MAX) : '');

/** True for the OS posting a share to this app. Anything else (a page, an asset, the bridge) is left alone. */
export function isShareRequest(request: { method: string; url: string }, scope: string): boolean {
  if (request.method !== 'POST') return false;
  try {
    const url = new URL(request.url);
    return url.origin === new URL(scope).origin && url.pathname === SHARE_PATH;
  } catch {
    return false;
  }
}

/** The shared fields of a posted form: text trimmed and cut, at most 5 non-empty files of at most 10 MB. */
export function shareFromForm(form: FormData): SharedContent {
  const files: File[] = [];
  for (const value of form.getAll('media')) {
    if (typeof value === 'string') continue;
    if (value.size > 0 && value.size <= SHARE_FILE_MAX_BYTES && files.length < SHARE_MAX_FILES) files.push(value);
  }
  return { title: clip(form.get('title')), text: clip(form.get('text')), url: clip(form.get('url')), files };
}

export const hasShare = (share: SharedContent): boolean => share.title !== '' || share.text !== '' || share.url !== '' || share.files.length > 0;

/**
 * The words that go in the message box: the title, the text and the link, each once. Many apps put the link
 * inside the text and repeat the page title, so a part already contained in another is dropped.
 */
export function shareToDraft(share: Pick<SharedContent, 'title' | 'text' | 'url'>): string {
  const parts = [share.title, share.text, share.url].filter((part) => part !== '');
  const kept = parts.filter((part, index) => !parts.some((other, at) => at !== index && other.length > part.length && other.includes(part)));
  return [...new Set(kept)].join('\n');
}

async function clearShare(caches: ShareCaches): Promise<void> {
  const cache = await caches.open(SHARE_CACHE);
  await cache.delete(META_KEY);
  for (let index = 0; index < SHARE_MAX_FILES; index += 1) await cache.delete(FILE_KEY(index));
}

export async function writeShare(caches: ShareCaches, share: SharedContent, now: number): Promise<void> {
  await clearShare(caches);
  const cache = await caches.open(SHARE_CACHE);
  const files = share.files.slice(0, SHARE_MAX_FILES);
  const meta = {
    title: share.title,
    text: share.text,
    url: share.url,
    at: now,
    files: files.map((file) => ({ name: file.name, type: file.type })),
  };
  await cache.put(META_KEY, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  for (const [index, file] of files.entries()) {
    await cache.put(FILE_KEY(index), new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }));
  }
}

/** Read the share and forget it, so it opens exactly once. `null` when there is none, it is stale or it is empty. */
export async function takeShare(caches: ShareCaches, now: number): Promise<SharedContent | null> {
  const cache = await caches.open(SHARE_CACHE);
  const hit = await cache.match(META_KEY);
  if (!hit) return null;
  try {
    const raw = (await hit.json()) as { title?: unknown; text?: unknown; url?: unknown; at?: unknown; files?: Array<{ name?: unknown; type?: unknown }> };
    if (typeof raw.at !== 'number' || now - raw.at > SHARE_TTL_MS || raw.at - now > SHARE_TTL_MS) return null;
    const files: File[] = [];
    for (const [index, entry] of (Array.isArray(raw.files) ? raw.files : []).slice(0, SHARE_MAX_FILES).entries()) {
      const stored = await cache.match(FILE_KEY(index));
      if (!stored) continue;
      const type = typeof entry.type === 'string' ? entry.type : '';
      files.push(new File([await stored.blob()], typeof entry.name === 'string' && entry.name ? entry.name : 'shared', { type }));
    }
    const share: SharedContent = { title: clip(raw.title), text: clip(raw.text), url: clip(raw.url), files };
    return hasShare(share) ? share : null;
  } catch {
    return null;
  } finally {
    await clearShare(caches).catch(() => undefined);
  }
}

/**
 * The service worker's answer to the OS post: keep what was shared and send the window to the app. A post that cannot
 * be read still opens the app (on its start screen), never an error page.
 */
export async function handleShareRequest(request: Pick<Request, 'formData'>, caches: ShareCaches, now: number, scope: string): Promise<Response> {
  let launched = false;
  try {
    const share = shareFromForm(await request.formData());
    if (hasShare(share)) {
      await writeShare(caches, share, now);
      launched = true;
    }
  } catch {
    /* an unreadable post, or Cache Storage unavailable: open the app without a share */
  }
  return Response.redirect(new URL(launched ? SHARE_LAUNCH : '/', scope).href, 303);
}
