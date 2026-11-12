// Bring my chats: the palette action opens a list of the agents that keep chats on this PC, with a count each, and picking
// one shows its newest chats. The agents' history folders are the synthetic fixtures of the repo, copied into the test app's
// own home folder. (Reading the chats into search and finding them is covered by the other tests of this area.)
import { seedOldChats, dismissAway } from './_area.mjs';

export const meta = {
  id: 'search.old-chats-bring-and-find',
  title: 'Bring my chats lists what each agent kept on this PC',
  area: 'search',
  tags: ['search', 'old-chats', 'smoke'],
  timeout: 90000,
};

export async function run(t) {
  await seedOldChats(t);
  await t.spawnPane('nimbus');

  await t.step('Open Bring my chats from the command palette');
  await dismissAway(t);
  await t.press('Ctrl+K');
  await t.page.type('bring my chats');
  await t.expect.text('Pick an agent, then bring its recent chats here. Nothing leaves this PC.');
  await t.press('Enter');

  await t.step('The agents with chats on this PC are listed with a count each');
  await t.expect.text('Pick an agent to see its chats on this PC. Nothing leaves this computer.', { timeout: 30000 });
  await t.expect.text('Claude · 2 chats');
  await t.expect.text('Codex CLI · 3 chats');

  await t.step('Pick an agent: its newest chats are listed');
  await t.click('Codex CLI · 3 chats');
  await t.expect.text('Codex CLI: newest chats first.');
}
