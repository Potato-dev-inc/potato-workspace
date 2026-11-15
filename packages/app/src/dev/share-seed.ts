// Evidence harness: puts what the phone's Share menu would have handed over into the real Cache Storage, where the service
// worker leaves it, so the app starts the way it does after a share (`/?share=1`).
import { shareFromForm, writeShare } from '../pwa/share-target';

/** A small coloured picture (a canvas PNG), so the chip shows a real thumbnail. */
async function samplePicture(): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#3a3733';
    ctx.fillRect(0, 0, 96, 64);
    ctx.fillStyle = '#e08a2c';
    ctx.fillRect(10, 10, 40, 6);
    ctx.fillStyle = '#c9c4bb';
    ctx.fillRect(10, 24, 70, 5);
    ctx.fillRect(10, 36, 54, 5);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new File([blob ?? new Blob(['x'])], 'screenshot.png', { type: 'image/png' });
}

export async function seedShare(share: { title?: string; text?: string; url?: string; picture?: boolean }): Promise<void> {
  const form = new FormData();
  if (share.title) form.append('title', share.title);
  if (share.text) form.append('text', share.text);
  if (share.url) form.append('url', share.url);
  if (share.picture) form.append('media', await samplePicture());
  await writeShare(caches, shareFromForm(form), Date.now());
}
