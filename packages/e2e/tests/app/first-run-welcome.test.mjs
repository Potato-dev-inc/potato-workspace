// A fresh profile shows the welcome once; Skip for now closes it. (Every other test starts with the welcome kept off, see calm().)
export const meta = {
  id: 'app.first-run-welcome',
  title: 'A fresh profile shows the welcome and Skip for now closes it',
  area: 'app',
  tags: ['first-run', 'smoke'],
};

export async function run(t) {
  // A fresh profile has no "welcome finished" setting and this window has never seen a pane. Make it so (no app restart
  // needed: a restart can mix up the launcher when other apps run at the same time, see forgetBridgePort in _area.mjs).
  for (const p of await t.panes()) await t.bridge.del(`/panes/${encodeURIComponent(p.id)}`).catch(() => {});
  await t.expect.eventually(async () => (await t.panes()).length === 0, { message: 'no panes at the start' });
  await t.page.eval(`window.__TAURI_INTERNALS__.invoke('settings_patch', { patch: { onboarding_done: null, onboarding_step: null } }).then(() => true)`);
  await t.page.eval('localStorage.clear()');
  await t.page.reload();

  await t.step('The welcome is on screen');
  await t.expect.text('Welcome to Potato Workspace');
  await t.expect.text('Your agents work here.');
  await t.expect.text('Step 1 of 5');
  await t.expect.visible('Skip for now');

  await t.step('Skip for now');
  await t.click('Skip for now');

  await t.step('The welcome is gone and the cockpit is free');
  await t.expect.noText('Step 1 of 5');
  await t.expect.text('No agents running.');
}
