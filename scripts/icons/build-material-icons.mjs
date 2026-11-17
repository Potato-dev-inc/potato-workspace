#!/usr/bin/env node
// Builds packages/app/src/lib/material-icons/{map,svgs}.generated.ts from a checkout of the Material Icon Theme
// (github.com/material-extensions/vscode-material-icon-theme, MIT; the app uses tag v5.40.0, commit 045291f).
// Usage: node scripts/icons/build-material-icons.mjs <src-dir>   where <src-dir> holds fileIcons.ts, folderIcons.ts and
// an icons/ folder (the theme's own files, unchanged). Only the curated names below are kept, to keep the bundle small.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const src = path.resolve(process.argv[2] ?? '.');
const out = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '../../packages/app/src/lib/material-icons');

const FILE_KEEP = new Set(`file html css sass less scss javascript react typescript typescript-def react_ts json yaml toml xml markdown readme changelog license python rust go java kotlin swift c cpp h hpp csharp ruby php powershell console sql database docker git npm yarn pnpm nodejs vite webpack eslint prettier tsconfig jest vitest cargo lock image svg font pdf word table powerpoint zip audio video log settings vue svelte astro tailwindcss next bun deno lua dart makefile cmake gradle maven tauri vscode claude copilot robots certificate key http graphql prisma tune editorconfig babel postcss github-actions-workflow gitlab-ci shell test-ts test-js test-jsx test-ts vercel netlify firebase git-ignore todo contributing authors conduct html-mixed cursor gemini openai nunjucks handlebars ini dotenv env zig elixir haskell r scala perl nix terraform azure-pipelines pipeline sublime pug jinja java-class jar xaml visualstudio rollup esbuild turborepo nx husky lefthook commitlint stylelint`.split(/\s+/));
const FOLDER_KEEP = new Set(`folder folder-root folder-src folder-dist folder-test folder-docs folder-node folder-git folder-github folder-vscode folder-config folder-images folder-public folder-scripts folder-components folder-lib folder-utils folder-packages folder-assets folder-css folder-sass folder-rust folder-tauri folder-claude folder-cursor folder-hook folder-log folder-temp folder-vendor folder-api folder-app folder-tools folder-types folder-database folder-docker folder-ci folder-build folder-target folder-i18n folder-plugin folder-mcp folder-examples folder-resource folder-template folder-python folder-javascript folder-typescript folder-react folder-backup folder-robot folder-layout folder-views folder-routes folder-server folder-client folder-core folder-shared folder-gh-workflows folder-github folder-husky folder-fonts folder-video folder-audio folder-icons folder-mock folder-secure folder-security folder-store folder-hooks folder-context folder-controller folder-model folder-service folder-middleware folder-migrations folder-coverage folder-cache folder-cypress folder-playwright folder-storybook folder-android folder-ios folder-windows folder-linux folder-macos folder-agent folder-prompts folder-ui folder-themes folder-trash folder-tests folder-gitlab folder-environment folder-pdf folder-research`.split(/\s+/));

const strip = (s, kind) =>
  s
    .replace(/^import .*$/gm, '')
    .replace(/export const \w+(: [\w\[\]<>]+)? =/, 'return')
    .replace(/parseByPattern\(/, '(')
    .replace(/IconPack\.\w+/g, '"pack"')
    .replace(/FileNamePattern\.\w+/g, '"pattern"');
const fileCfg = new Function(strip(readFileSync(path.join(src, 'fileIcons.ts'), 'utf8'), 'file') + ';')();
const folderThemes = new Function(strip(readFileSync(path.join(src, 'folderIcons.ts'), 'utf8'), 'folder') + ';')();

const svgOf = (name) => {
  const p = path.join(src, 'icons', `${name}.svg`);
  return existsSync(p) ? readFileSync(p, 'utf8').replace(/\s+/g, ' ').replace(/> </g, '><').trim() : null;
};
const svgs = {};
const need = (name, light) => {
  if (svgOf(name) === null) return false;
  svgs[name] = svgOf(name);
  if (light && svgOf(`${name}_light`)) svgs[`${name}_light`] = svgOf(`${name}_light`);
  return true;
};

const map = { ext: {}, file: {}, folder: {}, defaultFile: 'file', defaultFolder: 'folder', light: [] };
const missing = [];
need('document'); need('folder-base');
for (const e of fileCfg.icons) {
  if (e.enabledFor || !FILE_KEEP.has(e.name)) continue;
  if (!need(e.name, e.light)) { missing.push(e.name); continue; }
  if (e.light && svgs[`${e.name}_light`]) map.light.push(e.name);
  for (const x of e.fileExtensions ?? []) map.ext[x.toLowerCase()] ??= e.name;
  for (const f of e.fileNames ?? []) map.file[f.toLowerCase()] ??= e.name;
}
for (const theme of folderThemes) {
  if (theme.name !== 'specific') continue;
  for (const [special, key] of [[theme.defaultIcon, 'defaultFolder'], [theme.rootFolder, null]]) {
    if (special) {
      need(special.name, special.light);
      need(`${special.name}-open`, special.light);
    }
  }
  for (const e of theme.icons) {
    if (e.enabledFor || !FOLDER_KEEP.has(e.name)) continue;
    if (!need(e.name, e.light) ) { missing.push(e.name); continue; }
    need(`${e.name}-open`, e.light);
    if (e.light && svgs[`${e.name}_light`]) map.light.push(e.name);
    for (const f of e.folderNames ?? []) map.folder[f.toLowerCase()] ??= e.name;
  }
}
for (const n of [...Object.keys(svgs)]) if (n.endsWith('_light')) map.light.push(n.replace(/_light$/, '-open'), n.replace(/_light$/, ''));
map.light = [...new Set(map.light)].filter((n) => svgs[`${n}_light`]);
for (const n of FILE_KEEP) if (!svgs[n] && n !== 'file') missing.push(`(not found) ${n}`);

svgs.file = svgs.document; svgs.folder = svgs['folder-base']; delete svgs.document; delete svgs['folder-base'];
const head = '// GENERATED by scripts/icons/build-material-icons.mjs from Material Icon Theme v5.40.0 (MIT, see resources/legal/NOTICE-material-icon-theme.txt). Do not edit.\n';
writeFileSync(path.join(out, 'map.generated.ts'), `${head}export const ICON_MAP = ${JSON.stringify(map)} as const;\n`);
writeFileSync(path.join(out, 'svgs.generated.ts'), `${head}export const ICON_SVGS: Record<string, string> = ${JSON.stringify(svgs)};\n`);
console.log('icons', Object.keys(svgs).length, 'ext', Object.keys(map.ext).length, 'names', Object.keys(map.file).length, 'folders', Object.keys(map.folder).length);
console.log('missing', missing.join(' '));
