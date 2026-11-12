// An agent run started through the bridge (what an MCP client does) opens a visible pane that the cockpit lists, and the
// answer comes back with a receipt that says what was and was not verified.
import { mcp, firstRun, RUN_SCRIPT, guarded } from '../companion/_area.mjs';
import { PANE_ROW } from '../_helpers.mjs';

export const meta = {
  id: 'runs.visible-run-shows-pane',
  title: 'A run started over MCP opens a visible pane and returns an honest receipt',
  area: 'runs',
  tags: ['basic', 'mcp', 'smoke'],
};

export const run = guarded(async (t) => {
  t.fake.script(RUN_SCRIPT);
  const project = t.project('shop');
  const m = mcp(t);

  await t.step('An MCP client starts a run with run_agent');
  const started = await m.run({ agent_type: 'nimbus', project_path: project, task: 'tidy the shop page' });
  t.expect.equal(started.status, 200);
  const handle = started.body.handle;
  t.expect.ok(handle, 'the run has a handle');

  await t.step('The pane shows up in the sidebar, under its project');
  await t.expect.count(PANE_ROW, 1);
  await t.expect.visible('exact=shop', { within: 'css=.ck-side' });
  await t.expect.visible('Nimbus', { within: 'css=.ck-side' });

  await t.step('wait_agents returns the finished run');
  const done = firstRun(await m.wait(project, handle));
  t.expect.equal(done.status, 'completed');
  // The fake agent answers over the chat lane now (chat sessions are on by default): it echoes the task. A terminal-lane
  // agent would play the script instead; either way the run ends with an answer.
  t.expect.match(done.result, /echo: tidy the shop page|all done: first job/, 'the run returned an answer');

  await t.step('The receipt says which agent ran and what was NOT verified');
  const r = done.receipt;
  t.log('receipt: ' + JSON.stringify(r).slice(0, 700));
  t.expect.equal(r.outcome, 'completed_unchecked');
  t.expect.equal(r.fallback, null);
  t.expect.equal(done.verified, false);
  t.expect.ok(r.not_verified.some((s) => /no checks configured/.test(s)), 'it says no checks ran');

  await t.step('The finished run keeps its pane');
  t.expect.ok((await t.panes()).some((p) => p.id === done.pane_id), 'the run pane is still listed');
});
