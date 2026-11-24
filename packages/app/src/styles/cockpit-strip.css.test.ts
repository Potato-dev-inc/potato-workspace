// @vitest-environment node
// The thin sidebar strip (also forced on a narrow window, e.g. the phone-width browser page) shows marks only: the empty-state
// words and the "Bring my chats" link must not wrap one word per line inside 52 px.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync(new URL('./cockpit-resize.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

it('the strip hides the empty-state block, the Bring my chats link and the drop note', () => {
  const hidden = css.slice(css.indexOf('.cockpit[data-side-strip] .ck-wordmark'), css.indexOf('display: none;'));
  for (const sel of ['.ck-side-empty', '.ck-side-bring', '.ck-side-dropnote']) expect(hidden).toContain(`.cockpit[data-side-strip] ${sel}`);
});
