// One-click Worker setup from an app installed under a folder with spaces ("Program Files"): the built-in node runs npm
// there ("Installing the tool it needs"), and the flow stops before the Cloudflare sign-in. Run it with E2E_APP_EXE set
// to a copy of the app that has resources/node and resources/relay-worker beside it, in a folder whose name has a space.
// It never starts the sign-in step. needs-external: the install step downloads wrangler from the npm registry.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { calm, openSettings } from './_area.mjs';
import { invoke } from '../companion/_area.mjs';

export const meta = {
  id: 'settings.worker-setup-spaces',
  title: 'Worker setup runs its install step from an app folder with spaces, and stops before the sign-in',
  area: 'settings',
  tags: ['phone', 'needs-external'],
};

const nodeLines = () => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.CommandLine }`], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((l) => l.includes('npm-cli.js'));
  } catch {
    return [];
  }
};

export async function run(t) {
  if (!/ /.test(path.dirname(process.env.E2E_APP_EXE || ''))) t.skip('set E2E_APP_EXE to an app copy inside a folder with a space');
  const evidence = process.env.E2E_EVIDENCE_DIR;
  await calm(t);
  await openSettings(t, 'Connect');
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  if (evidence) await t.page.screenshot(path.join(evidence, 'settings-phone.png'));

  await t.step('Get the Worker files ready');
  const prep = await invoke(t, 'worker_update_step', { step: 'prepare', address: null });
  t.expect.ok(prep.ok && prep.ok.ok, `prepare: ${JSON.stringify(prep)}`);

  await t.step('Install the tool it needs (the built-in npm, run from the folder with a space)');
  let seen = [];
  const poll = setInterval(() => {
    for (const l of nodeLines()) if (!seen.includes(l)) seen.push(l);
  }, 700);
  let install;
  try {
    install = await invoke(t, 'worker_update_step', { step: 'install', address: null });
  } finally {
    clearInterval(poll);
  }
  if (evidence) fs.writeFileSync(path.join(evidence, 'install-result.json'), JSON.stringify({ result: install, nodeCommandLines: seen }, null, 2));
  t.log(`node command lines seen: ${JSON.stringify(seen)}`);
  t.expect.ok(install.ok && install.ok.ok, `install: ${JSON.stringify(install)}`);
  t.expect.ok(!/EISDIR|lstat/.test(JSON.stringify(install)), 'no EISDIR/lstat error');
  t.expect.ok(seen.some((l) => / /.test(l) && l.includes('npm-cli.js')), 'npm ran from a path that has a space');

  await t.step('Stop here: the Cloudflare sign-in is not started');
  if (evidence) await t.page.screenshot(path.join(evidence, 'after-install.png'));
}
