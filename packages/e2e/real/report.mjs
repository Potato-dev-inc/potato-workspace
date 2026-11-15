// Writes report.md and report.json for one run: a pass/fail table, the evidence, and the honest limits.
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function writeReport(dir, run) {
  const L = [];
  L.push(`# Real-app check: run ${run.runId}`, '');
  L.push(`**Mode: ran from an extracted copy of the MSI (not installed).** No shortcuts, registry, URL handler or uninstall were exercised. Not enough on its own to ship (Fable decision 1).`, '');
  L.push('| | |', '|---|---|');
  for (const [k, v] of run.header) L.push(`| ${esc(k)} | ${esc(v)} |`);
  L.push('');
  L.push('## Verdict', '', `**${run.verdict}**: ${run.summary}`, '');
  L.push('## Results', '', '| Check | Result | Evidence |', '|---|---|---|');
  for (const r of run.rows) L.push(`| ${esc(r.name)} | ${esc(r.result)} | ${esc(r.evidence)} |`);
  L.push('');
  if (run.flows?.length) {
    L.push('## Real-agent flows', '');
    for (const f of run.flows) {
      L.push(`### ${f.id}: ${f.title} - ${f.verdict}`, '');
      for (const c of f.checks) L.push(`- ${c.ok ? 'PASS' : 'FAIL'}: ${esc(c.name)}${c.detail ? ' (' + esc(c.detail) + ')' : ''}`);
      L.push('');
    }
  }
  if (run.findings?.length) {
    L.push('## Findings from the screen checks', '', '| Screen | Theme | Check | What | Detail |', '|---|---|---|---|---|');
    for (const f of run.findings) L.push(`| ${esc(f.screen)} | ${esc(f.theme)} | ${esc(f.check)} | ${esc(f.what)} | ${esc(f.detail)} |`);
    L.push('');
  }
  L.push('## Founder files untouched', '');
  for (const l of run.guardLines) L.push(`- ${l}`);
  L.push('', '## Cleanup', '');
  for (const l of run.cleanupLines) L.push(`- ${l}`);
  L.push('', '## Not covered here', '');
  for (const l of run.notCovered) L.push(`- ${l}`);
  L.push('');
  fs.writeFileSync(path.join(dir, 'report.md'), L.join('\n'));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(run, null, 2));
}
