#!/usr/bin/env node
/**
 * Looks inside a built MSI (Windows only: it asks the Windows Installer for the File table) and checks what the package
 * carries. Part of the app-only update build (docs/features/app-only-updates.md).
 *
 *   node scripts/check-msi-contents.mjs <file.msi> full|app-only
 *
 * full:      has the app, the MCP program and the three tools (Node, Git, cloudflared) and tools-manifest.json.
 * app-only:  has the app and the MCP program, and NONE of the tools or the manifest; the file is under 60 MB.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const APP_FILES = ['puppet_master_app.exe', 'puppet-master-mcp.exe'];
export const TOOL_FILES = ['node.exe', 'git.exe', 'cloudflared.exe', 'tools-manifest.json'];
/** The app-only installer must stay below this (it is about 39 MB on 1.1.1). */
export const APP_ONLY_MAX_BYTES = 60 * 1024 * 1024;

/** The long file name of a File table entry (`SHORT~1.EXE|Long Name.exe`). */
export function longName(entry) {
  const parts = String(entry).split('|');
  return parts[parts.length - 1];
}

/** Pure: the problems with the file names of one package. `kind` is `full` or `app-only`. */
export function problemsFor(names, kind, bytes) {
  const have = new Set(names.map((n) => longName(n).toLowerCase()));
  const out = [];
  for (const f of APP_FILES) if (!have.has(f)) out.push(`missing ${f}`);
  if (kind === 'full') {
    for (const f of TOOL_FILES) if (!have.has(f)) out.push(`the full installer is missing ${f}`);
  } else {
    for (const f of TOOL_FILES) if (have.has(f)) out.push(`the app-only installer carries ${f}`);
    if (bytes !== undefined && bytes > APP_ONLY_MAX_BYTES) out.push(`the app-only installer is ${bytes} bytes (over ${APP_ONLY_MAX_BYTES})`);
  }
  return out;
}

const PS = `
param([string]$Path)
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($Path, 0))
$view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @('SELECT FileName FROM File'))
$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
while ($true) {
  $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
  if ($null -eq $rec) { break }
  $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, @(1))
}
`;

/** The File table names of an MSI, by asking the Windows Installer. */
export function fileNames(msi) {
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${PS} } -Path '${msi.replace(/'/g, "''")}'`], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`could not read ${msi}: ${res.stderr || res.stdout}`);
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function main() {
  const [msi, kind] = process.argv.slice(2);
  if (!msi || !['full', 'app-only'].includes(kind)) {
    console.error('usage: node scripts/check-msi-contents.mjs <file.msi> full|app-only');
    process.exit(2);
  }
  const names = fileNames(msi);
  const problems = problemsFor(names, kind, statSync(msi).size);
  if (problems.length) {
    console.error(`[check-msi-contents] ${msi} (${kind}):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.error(`[check-msi-contents] ok: ${msi} is a good ${kind} installer (${names.length} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
