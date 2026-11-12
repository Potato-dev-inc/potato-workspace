// A chat survives a restart of the app: same conversation, same messages, and it still answers.
import { say, chatPanes, calm, MESSAGE_BOX } from './_area.mjs';

export const meta = {
  id: 'acp.restart-restores-chat',
  title: 'After the app restarts, the chat is back with its messages and still answers',
  area: 'acp',
  tags: ['acp', 'labs', 'smoke', 'persistence'],
  fresh: true,
  timeout: 180000,
};

/** Chat sessions are on by default: start a Nimbus chat the way the app does (the same call as the New agent page's Chat button). */
async function startNimbusChat(t) {
  await calm(t);
  await t.step('Start a chat with Nimbus');
  const folder = t.project('restart-chat');
  await t.page.eval(`window.__TAURI_INTERNALS__.invoke('acp_chat_start', { agentId: 'nimbus', folder: ${JSON.stringify(folder)}, explicit: true }).then(() => true)`);
  await t.expect.eventually(async () => (await chatPanes(t)).length === 1, { timeout: 30000, message: 'a chat pane is listed' });
  await t.click('exact=Nimbus', { within: 'css=.ck-side' });
  await t.waitFor(MESSAGE_BOX);
  return (await chatPanes(t))[0];
}

export async function run(t) {
  const pane = await startNimbusChat(t);

  await t.step('Talk to the agent');
  await say(t, 'stream 3');
  await t.expect.text('w2');

  await t.step('Restart the app');
  await t.restartApp();
  await t.expect.eventually(async () => (await chatPanes(t)).length === 1, { timeout: 30000, message: 'the chat is listed again' });
  t.expect.equal((await chatPanes(t))[0].id, pane.id, 'the same conversation');

  await t.step('Open it: the earlier messages are there and it answers');
  await t.click('exact=Nimbus', { within: 'css=.ck-side' });
  await t.waitFor(MESSAGE_BOX);
  await t.expect.text('stream 3');
  await t.expect.text('w2');
  await say(t, 'stream 2');
  await t.expect.text('w1');
}
