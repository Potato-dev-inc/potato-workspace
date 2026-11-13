// Shared steps for the wf-notify evidence scenarios (notification levels, quiet hours): the pane menu bell rows,
// the Look and feel page with quiet hours on, and an agent page with its Notifications rows.
import type { HarnessDom } from './types';

export const bellMenu = async (dom: HarnessDom) => {
  await dom.clickText('[role="tab"]', 'Chat');
  await dom.waitFor('[data-testid="pane-head-chat"]');
  await dom.sleep(300);
  await dom.clickText('.ck-pane-head button[aria-haspopup="menu"]', '⋯');
  await dom.waitFor('.ck-menu--float[role="menu"]');
  await dom.sleep(400);
};

export const quietRow = async (dom: HarnessDom) => {
  await dom.waitFor('.st-adv-toggle');
  await dom.click('.st-adv-toggle');
  await dom.waitFor('[data-row="quiet-hours"]');
  await dom.click('[role="switch"][aria-label="Quiet hours"]');
  await dom.sleep(300);
  document.querySelector('[data-row="quiet-hours"]')?.scrollIntoView({ block: 'center' });
  await dom.sleep(300);
};

export const agentRows = async (dom: HarnessDom) => {
  await dom.waitFor('[data-testid="agent-row-claude"]');
  await dom.sleep(400);
  await dom.click('[data-testid="agent-row-claude"] .ag-open');
  await dom.waitFor('select[aria-label="Notifications for Claude"]');
  document.querySelector('select[aria-label="Notifications for Claude"]')?.scrollIntoView({ block: 'center' });
  await dom.sleep(500);
};
