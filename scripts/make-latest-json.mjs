#!/usr/bin/env node
/**
 * After a signed release build: writes latest.json (what the app's updater reads) next to the MSI to upload.
 *
 *   node scripts/make-latest-json.mjs <bundle-msi-folder> <out-folder> [<app-only-msi-folder>]
 *
 * Reads `Potato Workspace_<version>_x64_en-US.msi` and its `.sig` (made by `tauri build` when createUpdaterArtifacts is on and
 * TAURI_SIGNING_PRIVATE_KEY is set), copies the MSI to `Potato-Workspace_<version>_x64_en-US.msi` (the name to upload to the
 * GitHub release v<version>) and writes `latest.json` with the version, the notes from CHANGELOG.md, the signature and
 * the asset URL. The private key is never read here: only the finished .sig file is.
 *
 * With the third argument (the folder that holds the app-only MSI and its .sig, see scripts/build-app-only-msi.sh) the
 * file gets a second target, `windows-x86_64-app`, and a `potato.appOnly` block (docs/features/app-only-updates.md):
 * the app-only MSI is copied to `Potato-Workspace_<version>_x64_app-only-update.msi`. Without it the output is exactly
 * the one-platform file of every earlier release. Exit 1 when the two MSIs are for different versions or the app-only one
 * is not smaller.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The oldest running version that may take the app-only package: the first one that has the tools resolver. */
export const APP_ONLY_MIN_FROM = '1.2.0';
const REPO = 'https://github.com/Potato-dev-inc/potato-workspace/releases/download';

/** Pure: the latest.json object. `appOnly` is `{ signature, asset, size, fullSize, toolsVersion }` or null. */
export function buildLatest({ version, notes, pubDate, signature, asset, appOnly }) {
  const platforms = {
    'windows-x86_64': { signature, url: `${REPO}/v${version}/${asset}` },
  };
  const latest = { version, notes, pub_date: pubDate, platforms };
  if (appOnly) {
    platforms['windows-x86_64-app'] = { signature: appOnly.signature, url: `${REPO}/v${version}/${appOnly.asset}` };
    latest.potato = {
      appOnly: { toolsVersion: appOnly.toolsVersion, size: appOnly.size, fullSize: appOnly.fullSize, minFrom: APP_ONLY_MIN_FROM },
    };
  }
  return latest;
}

/** The MSI versions in a folder: names like `Potato Workspace_1.2.1_x64_en-US.msi`. */
export function versionsIn(folder) {
  return readdirSync(folder)
    .map((n) => /^Potato Workspace_(.+)_x64_en-US\.msi$/.exec(n)?.[1])
    .filter(Boolean);
}

function main() {
  const root = process.env.PM_LATEST_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
  const [bundleDir, outDir, appOnlyDir] = process.argv.slice(2);
  if (!bundleDir || !outDir) {
    console.error('usage: node scripts/make-latest-json.mjs <bundle-msi-folder> <out-folder> [<app-only-msi-folder>]');
    process.exit(2);
  }
  const conf = JSON.parse(readFileSync(join(root, 'packages/app/src-tauri/tauri.conf.json'), 'utf8'));
  const version = conf.version;
  const built = join(bundleDir, `Potato Workspace_${version}_x64_en-US.msi`);
  const sig = `${built}.sig`;
  if (!existsSync(built) || !existsSync(sig)) {
    console.error(`missing ${built} or its .sig (was TAURI_SIGNING_PRIVATE_KEY set for the build?)`);
    process.exit(1);
  }
  const asset = `Potato-Workspace_${version}_x64_en-US.msi`;
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const section = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(changelog);
  const notes = (section?.[1] ?? '').trim();

  let appOnly = null;
  let appOnlyBuilt = null;
  if (appOnlyDir) {
    appOnlyBuilt = join(appOnlyDir, `Potato Workspace_${version}_x64_en-US.msi`);
    const appSig = `${appOnlyBuilt}.sig`;
    if (!existsSync(appOnlyBuilt) || !existsSync(appSig)) {
      const other = existsSync(appOnlyDir) ? versionsIn(appOnlyDir) : [];
      console.error(
        other.length
          ? `the app-only MSI is for ${other.join(', ')} but the full MSI is for ${version}: not writing a mixed latest.json`
          : `missing ${appOnlyBuilt} or its .sig`,
      );
      process.exit(1);
    }
    const size = statSync(appOnlyBuilt).size;
    const fullSize = statSync(built).size;
    if (size >= fullSize) {
      console.error(`the app-only MSI (${size} bytes) is not smaller than the full one (${fullSize} bytes)`);
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(join(root, 'packages/app/src-tauri/resources/tools-manifest.json'), 'utf8'));
    appOnly = {
      signature: readFileSync(appSig, 'utf8').trim(),
      asset: `Potato-Workspace_${version}_x64_app-only-update.msi`,
      size,
      fullSize,
      toolsVersion: manifest.toolsVersion,
    };
  }

  mkdirSync(outDir, { recursive: true });
  copyFileSync(built, join(outDir, asset));
  if (appOnly) copyFileSync(appOnlyBuilt, join(outDir, appOnly.asset));
  const latest = buildLatest({ version, notes, pubDate: new Date().toISOString(), signature: readFileSync(sig, 'utf8').trim(), asset, appOnly });
  writeFileSync(join(outDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  console.error(`[make-latest-json] ${asset}${appOnly ? ` + ${appOnly.asset}` : ''} + latest.json for ${version} written to ${outDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
