import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileIconId, folderIconId, hasLightVariant, iconSvg, loadIconSvgs } from './index';
import { ICON_SVGS } from './svgs.generated';

describe('file icon by name', () => {
  it('uses the extension', () => {
    expect(fileIconId('src/app.tsx')).toBe('react_ts');
    expect(fileIconId('main.rs')).toBe('rust');
    expect(fileIconId('notes.md')).toBe('markdown');
  });
  it('prefers the longest extension', () => {
    expect(fileIconId('types/index.d.ts')).toBe('typescript-def');
    expect(fileIconId('a.ts')).toBe('typescript');
  });
  it('prefers an exact file name over its extension', () => {
    expect(fileIconId('package.json')).toBe('nodejs');
    expect(fileIconId('docs/README.md')).toBe('readme');
    expect(fileIconId('.gitignore')).toBe('git');
    expect(fileIconId('a.json')).toBe('json');
  });
  it('falls back to a plain file', () => {
    expect(fileIconId('mystery.zzzz')).toBe('file');
    expect(fileIconId('noext')).toBe('file');
  });
});

describe('folder icon by name', () => {
  it('knows special folders, with or without a dot', () => {
    expect(folderIconId('src')).toBe('folder-src');
    expect(folderIconId('.github')).toBe('folder-github');
    expect(folderIconId('a/b/node_modules')).toBe('folder-node');
    expect(folderIconId('.vscode')).toBe('folder-vscode');
    expect(folderIconId('docs')).toBe('folder-docs');
  });
  it('falls back to a plain folder; open ones add -open', () => {
    expect(folderIconId('whatever')).toBe('folder');
    expect(folderIconId('src', true)).toBe('folder-src-open');
  });
});

describe('pictures', () => {
  it('every mapped icon has a picture, and open folders fall back to the closed one', async () => {
    await loadIconSvgs();
    for (const id of ['react', 'readme', 'folder-src', 'folder-github', 'file', 'folder']) expect(iconSvg(ICON_SVGS, id)).toContain('<svg');
    expect(iconSvg(ICON_SVGS, 'folder-src-open')).toBe(iconSvg(ICON_SVGS, 'folder-src'));
    expect(iconSvg(ICON_SVGS, 'nonsense')).toBe(iconSvg(ICON_SVGS, 'file'));
    expect(hasLightVariant('toml')).toBe(true);
    expect(iconSvg(ICON_SVGS, 'toml', true)).not.toBe(iconSvg(ICON_SVGS, 'toml'));
  });
  it('ships the licence notice', () => {
    const t = readFileSync(new URL('../../../src-tauri/resources/legal/NOTICE-material-icon-theme.txt', import.meta.url), 'utf8');
    expect(t).toContain('MIT License');
    expect(t).toContain('Material Extensions');
    expect(t).toContain('045291ff');
  });
});
