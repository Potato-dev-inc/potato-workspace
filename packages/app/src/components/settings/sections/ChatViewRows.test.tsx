// @vitest-environment jsdom
// Settings > Agents > Chat: "Chat detail" (the start level of a new chat: Summary until changed) and the global switch
// for the "Done means" line. Both save on this device and come in English and Traditional Chinese.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref, t } from '../../../i18n';
import { CHAT_VIEW_DEFAULT_KEY, getChatViewDefault, readChatViewMode, setChatViewDefault } from '../../chat/chatViewMode';
import { DONE_CARD_KEY, getDoneCardOn, setDoneCardOn } from '../../../lib/done-card';
import { click, mountRows, pickOption, type Mounted } from '../test-utils';
import { agentsRows } from './AgentsSection';

let m: Mounted;
const rows = agentsRows.filter((row) => row.id === 'chat-view' || row.id === 'done-card');

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  setChatViewDefault('summary');
  setDoneCardOn(true);
});
afterEach(async () => {
  await m?.unmount();
  localStorage.clear();
  setChatViewDefault('summary');
  setDoneCardOn(true);
});

describe('Chat detail and Done means (Settings > Agents > Chat)', () => {
  it('both rows are in the Chat group', () => {
    expect(rows.map((r) => [r.id, r.group])).toEqual([
      ['chat-view', 'Chat'],
      ['done-card', 'Chat'],
    ]);
  });

  it('Chat detail starts on Summary, and the choice is the start level of chats that never chose', async () => {
    m = await mountRows(rows);
    const select = m.host.querySelector<HTMLSelectElement>('select[aria-label="Chat detail"]')!;
    expect(select.value).toBe('summary');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Summary', 'Normal', 'Verbose']);
    await pickOption(select, 'verbose');
    expect(getChatViewDefault()).toBe('verbose');
    expect(localStorage.getItem(CHAT_VIEW_DEFAULT_KEY)).toBe('verbose');
    expect(readChatViewMode('a-chat-that-never-chose')).toBe('verbose');
    // A chat that chose Normal earlier keeps it.
    localStorage.setItem('pm.chatView.kept', 'normal');
    expect(readChatViewMode('kept')).toBe('normal');
  });

  it('the Done means switch is on by default, saves on this device, and turns back on', async () => {
    m = await mountRows(rows);
    const toggle = () => m.host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await click(toggle());
    expect(getDoneCardOn()).toBe(false);
    expect(localStorage.getItem(DONE_CARD_KEY)).toBe('0');
    await click(toggle());
    expect(getDoneCardOn()).toBe(true);
  });

  it('has Traditional Chinese words', () => {
    setLanguagePref('zh-TW', false);
    expect(t('settings.row.chat-view.label')).toBe('對話的詳細程度');
    expect(t('chatView.label', { mode: t('chatView.summary') })).toBe('檢視：摘要');
    expect(t('done.hideProject')).toBe('這個專案不要顯示');
    setLanguagePref('en', false);
  });
});
