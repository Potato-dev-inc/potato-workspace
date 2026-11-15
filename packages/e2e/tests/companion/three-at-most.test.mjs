// At most eight saved companions: the ninth is refused until one is archived (three may be awake at once).
import { noCompanions, makeCompanion, invoke, draft, companionList, guarded } from './_area.mjs';

export const meta = {
  id: 'companion.three-at-most',
  title: 'A ninth companion is refused until one is archived',
  area: 'companion',
  tags: [],
  edge: true,
};

export const run = guarded(async (t) => {
  await noCompanions(t);
  await t.step('Make eight companions');
  for (const [name, avatar] of [['Mochi', 'mochi'], ['Bit', 'bit'], ['Nib', 'nib'], ['Tofu', 'tofu'], ['Lumen', 'lumen'], ['Hoot', 'hoot'], ['Sprout', 'sprout'], ['Kit', 'kit']]) await makeCompanion(t, { name, avatar });
  await t.page.reload();
  await t.expect.count('css=.ck-companion-row', 8);

  await t.step('A ninth is refused with a plain sentence');
  const r = await invoke(t, 'companion_create', { input: draft({ name: 'Pip', avatar: 'bit' }) });
  t.expect.ok(r.err && r.err.includes('COMPANION_LIMIT'), `refused (${JSON.stringify(r)})`);
  t.expect.includes(r.err, 'Archive one first.');
  t.expect.equal((await companionList(t)).length, 8, 'still eight');

  await t.step('Archive one and the ninth fits');
  await invoke(t, 'companion_archive', { id: 'nib' });
  const ok = await invoke(t, 'companion_create', { input: draft({ name: 'Pip', avatar: 'bit' }) });
  t.expect.ok(ok.ok, 'the ninth was made after archiving one');
});
