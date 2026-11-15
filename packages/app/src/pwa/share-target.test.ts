import { describe, expect, it } from 'vitest';
import {
  SHARE_CACHE,
  SHARE_FILE_MAX_BYTES,
  SHARE_MAX_FILES,
  SHARE_TARGET_MANIFEST,
  SHARE_TEXT_MAX,
  SHARE_TTL_MS,
  handleShareRequest,
  isShareRequest,
  shareFromForm,
  shareToDraft,
  takeShare,
  writeShare,
  type ShareCaches,
} from './share-target';

/** A fake Cache Storage: named caches holding responses by key. */
function fakeCaches() {
  const store = new Map<string, Map<string, Response>>();
  const caches: ShareCaches = {
    async open(name) {
      const cache = store.get(name) ?? new Map<string, Response>();
      store.set(name, cache);
      return {
        async put(key, response) {
          cache.set(key, response);
        },
        async match(key) {
          const hit = cache.get(key);
          return hit ? hit.clone() : undefined;
        },
        async delete(key) {
          return cache.delete(key);
        },
      };
    },
  };
  return { caches, store };
}

const NOW = 1_800_000_000_000;
const SCOPE = 'https://phone.example.test/';
const form = (fields: Record<string, string>, files: File[] = []) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  for (const file of files) data.append('media', file);
  return data;
};
const photo = (name = 'screenshot.png', size = 4) => new File([new Uint8Array(size).fill(7)], name, { type: 'image/png' });

describe('the manifest entry', () => {
  it('posts text, a link and files to /share-target as a form', () => {
    expect(SHARE_TARGET_MANIFEST).toMatchObject({ action: '/share-target', method: 'POST', enctype: 'multipart/form-data' });
    expect(SHARE_TARGET_MANIFEST.params).toMatchObject({ title: 'title', text: 'text', url: 'url' });
    expect(SHARE_TARGET_MANIFEST.params.files[0].name).toBe('media');
    expect(SHARE_TARGET_MANIFEST.params.files[0].accept).toContain('image/*');
  });
});

describe('which requests the worker takes', () => {
  it('only a POST to /share-target on its own origin', () => {
    expect(isShareRequest({ method: 'POST', url: `${SCOPE}share-target` }, SCOPE)).toBe(true);
    expect(isShareRequest({ method: 'GET', url: `${SCOPE}share-target` }, SCOPE)).toBe(false);
    expect(isShareRequest({ method: 'POST', url: `${SCOPE}bridge/panes` }, SCOPE)).toBe(false);
    expect(isShareRequest({ method: 'POST', url: 'https://other.example.test/share-target' }, SCOPE)).toBe(false);
    expect(isShareRequest({ method: 'POST', url: 'not a url' }, SCOPE)).toBe(false);
  });
});

describe('reading what was shared', () => {
  it('keeps trimmed text, a link and files', () => {
    const share = shareFromForm(form({ title: '  A page ', text: 'look at this', url: 'https://example.com/a' }, [photo()]));
    expect(share).toMatchObject({ title: 'A page', text: 'look at this', url: 'https://example.com/a' });
    expect(share.files.map((f) => f.name)).toEqual(['screenshot.png']);
  });

  it('cuts long text, drops empty and oversized files, keeps at most five', () => {
    const big = new File([new Uint8Array(SHARE_FILE_MAX_BYTES + 1)], 'big.png', { type: 'image/png' });
    const share = shareFromForm(
      form({ text: 'x'.repeat(SHARE_TEXT_MAX + 50) }, [big, photo('empty.png', 0), ...Array.from({ length: 8 }, (_, i) => photo(`p${i}.png`))]),
    );
    expect(share.text).toHaveLength(SHARE_TEXT_MAX);
    expect(share.files).toHaveLength(SHARE_MAX_FILES);
    expect(share.files.map((f) => f.name)).toEqual(['p0.png', 'p1.png', 'p2.png', 'p3.png', 'p4.png']);
  });

  it('puts the title, text and link in the box once each', () => {
    expect(shareToDraft({ title: 'A page', text: 'look at this', url: 'https://example.com/a' })).toBe('A page\nlook at this\nhttps://example.com/a');
    // Many apps put the link inside the text and repeat it in the url field.
    expect(shareToDraft({ title: '', text: 'Great read https://example.com/a', url: 'https://example.com/a' })).toBe('Great read https://example.com/a');
    expect(shareToDraft({ title: 'Same', text: 'Same', url: '' })).toBe('Same');
    expect(shareToDraft({ title: '', text: '', url: '' })).toBe('');
  });
});

describe('the share cache', () => {
  it('writes the share and reads it back once, files included', async () => {
    const { caches, store } = fakeCaches();
    await writeShare(caches, shareFromForm(form({ text: 'hello', url: 'https://example.com' }, [photo('a.png', 6)])), NOW);
    expect(store.has(SHARE_CACHE)).toBe(true);
    const share = await takeShare(caches, NOW + 5_000);
    expect(share).toMatchObject({ text: 'hello', url: 'https://example.com', title: '' });
    expect(share!.files).toHaveLength(1);
    expect(share!.files[0]).toMatchObject({ name: 'a.png', type: 'image/png', size: 6 });
    expect(await takeShare(caches, NOW + 5_001)).toBeNull();
    expect(store.get(SHARE_CACHE)!.size).toBe(0);
  });

  it('a newer share replaces an older one, files and all', async () => {
    const { caches, store } = fakeCaches();
    await writeShare(caches, shareFromForm(form({ text: 'old' }, [photo('1.png'), photo('2.png')])), NOW);
    await writeShare(caches, shareFromForm(form({ text: 'new' })), NOW + 1);
    expect(store.get(SHARE_CACHE)!.size).toBe(1);
    expect(await takeShare(caches, NOW + 2)).toMatchObject({ text: 'new', files: [] });
  });

  it('a stale share is dropped and forgotten', async () => {
    const { caches, store } = fakeCaches();
    await writeShare(caches, shareFromForm(form({ text: 'late' })), NOW);
    expect(await takeShare(caches, NOW + SHARE_TTL_MS + 1)).toBeNull();
    expect(store.get(SHARE_CACHE)!.size).toBe(0);
  });

  it('nothing there, or a damaged entry, is null and never throws', async () => {
    const { caches } = fakeCaches();
    expect(await takeShare(caches, NOW)).toBeNull();
    const cache = await caches.open(SHARE_CACHE);
    await cache.put('/__pm_share__', new Response('not json'));
    expect(await takeShare(caches, NOW)).toBeNull();
  });
});

describe('the worker answering the OS post', () => {
  it('keeps the share and redirects to the app with ?share=1', async () => {
    const { caches } = fakeCaches();
    const request = new Request(`${SCOPE}share-target`, { method: 'POST', body: form({ title: 'T', text: 'see this' }, [photo()]) });
    const response = await handleShareRequest(request, caches, NOW, SCOPE);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${SCOPE}?share=1`);
    expect(await takeShare(caches, NOW + 1)).toMatchObject({ title: 'T', text: 'see this' });
  });

  it('an empty share opens the app on its start screen, with nothing kept', async () => {
    const { caches, store } = fakeCaches();
    const request = new Request(`${SCOPE}share-target`, { method: 'POST', body: form({ text: '   ' }) });
    const response = await handleShareRequest(request, caches, NOW, SCOPE);
    expect(response.headers.get('location')).toBe(SCOPE);
    expect(store.get(SHARE_CACHE)?.size ?? 0).toBe(0);
  });

  it('a post that cannot be read, or a cache that fails, still opens the app', async () => {
    const { caches } = fakeCaches();
    const broken = await handleShareRequest({ formData: async () => Promise.reject(new Error('bad body')) }, caches, NOW, SCOPE);
    expect(broken.status).toBe(303);
    expect(broken.headers.get('location')).toBe(SCOPE);
    const failing: ShareCaches = { open: async () => Promise.reject(new Error('no storage')) };
    const request = new Request(`${SCOPE}share-target`, { method: 'POST', body: form({ text: 'hi' }) });
    const response = await handleShareRequest(request, failing, NOW, SCOPE);
    expect(response.headers.get('location')).toBe(SCOPE);
  });
});
