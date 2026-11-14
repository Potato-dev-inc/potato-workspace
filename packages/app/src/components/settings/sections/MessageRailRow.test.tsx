// @vitest-environment jsdom
// Settings > Agents > Chat > Message rail: on by default, the switch saves on this device (not in settings.json),
// and the words come in English and Traditional Chinese.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref, t } from '../../../i18n';
import { MESSAGE_RAIL_KEY, getMessageRail, setMessageRail } from '../../../lib/messageRail';
import { click, mountRows, type Mounted } from '../test-utils';
import { agentsRows } from './AgentsSection';

let m: Mounted;
const rows = agentsRows.filter((row) => row.id === 'message-rail');
const toggle = () => m.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Message rail"]')!;

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.removeItem(MESSAGE_RAIL_KEY);
  setMessageRail(true);
});
afterEach(async () => {
  await m?.unmount();
  localStorage.removeItem(MESSAGE_RAIL_KEY);
  setMessageRail(true);
});

describe('Message rail setting', () => {
  it('is in the Chat group and on by default', async () => {
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe('Chat');
    m = await mountRows(rows);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(m.host.textContent).toContain('one per message');
  });

  it('switching it off is remembered on this device and switching on brings it back', async () => {
    m = await mountRows(rows);
    await click(toggle());
    expect(getMessageRail()).toBe(false);
    expect(localStorage.getItem(MESSAGE_RAIL_KEY)).toBe('0');
    await click(toggle());
    expect(getMessageRail()).toBe(true);
    expect(localStorage.getItem(MESSAGE_RAIL_KEY)).toBe('1');
  });

  it('has Traditional Chinese words', () => {
    setLanguagePref('zh-TW', false);
    expect(t('settings.row.message-rail.label')).toBe('訊息導覽列');
    expect(t('chatUx.rail.you')).toBe('你');
    setLanguagePref('en', false);
  });
});
