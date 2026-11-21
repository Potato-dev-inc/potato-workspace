// @vitest-environment jsdom
// SSH agent chat and the device door are early (Labs) switches. They are only on the Labs page and only the app
// window can set them (the phone and agents cannot), so the page must show them and save through the window's patch.
import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../../i18n/en';
import { zhTW } from '../../i18n/zh-TW';
import { setDevLabsOverrideForTests } from '../../lib/dev-labs';
import { arrangeSections, LABS_INDEX_ID } from './arrange';
import { BASE_SECTIONS } from './catalog';
import { click, mountRows, settle, type Mounted, type as typeInto } from './test-utils';

let m: Mounted | undefined;
afterEach(async () => {
  await m?.unmount();
  m = undefined;
  setDevLabsOverrideForTests(false);
});

const labsIndex = () => arrangeSections(BASE_SECTIONS).find((s) => s.id === 'labs')!.rows.find((r) => r.id === LABS_INDEX_ID)!;
const search = () => m!.host.querySelector<HTMLInputElement>('input[type="search"]')!;
const sw = (label: string) => m?.host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);

describe('the SSH chat and device door Labs switches', () => {
  it('SSH agent chat shows off on the Labs page and saves ssh_chat_enabled when switched on', async () => {
    m = await mountRows([labsIndex()]);
    await settle(3);
    await typeInto(search(), 'ssh');
    await settle(2);
    expect(sw('SSH agent chat')).not.toBeNull();
    expect(sw('SSH agent chat')!.getAttribute('aria-checked')).toBe('false');
    await click(sw('SSH agent chat'));
    await settle(2);
    expect(m.env.patches).toEqual([{ ssh_chat_enabled: true }]);
  });

  it('Device door shows off on the Labs page and saves pcdoor_enabled when switched on', async () => {
    m = await mountRows([labsIndex()]);
    await settle(3);
    await typeInto(search(), 'door');
    await settle(2);
    expect(sw('Device door over my web address')).not.toBeNull();
    expect(sw('Device door over my web address')!.getAttribute('aria-checked')).toBe('false');
    await click(sw('Device door over my web address'));
    await settle(2);
    expect(m.env.patches).toEqual([{ pcdoor_enabled: true }]);
  });

  it('has English and Traditional Chinese words for both, the English hint saying it is experimental', () => {
    for (const id of ['ssh-chat-labs', 'pcdoor-labs']) {
      for (const key of [`settings.row.${id}.label`, `settings.row.${id}.hint`, `labs.${id}.name`, `labs.${id}.about`, `labsPage.line.${id}`]) {
        expect((en as Record<string, string>)[key], key).toBeTruthy();
        expect((zhTW as Record<string, string>)[key], key).toBeTruthy();
      }
      expect((en as Record<string, string>)[`settings.row.${id}.hint`]).toMatch(/Experimental/);
    }
  });
});
