// File and folder icons from the Material Icon Theme (MIT, see resources/legal/NOTICE-material-icon-theme.txt).
// The name -> icon rules (`map.generated.ts`) are small and always loaded; the pictures (`svgs.generated.ts`) load once,
// on first use, as their own chunk. Nothing here knows an agent or a product: it only looks at file and folder names.
import { useSyncExternalStore } from 'react';
import { ICON_MAP } from './map.generated';

const M = ICON_MAP as unknown as {
  ext: Record<string, string>;
  file: Record<string, string>;
  folder: Record<string, string>;
  light: string[];
};

const FILE_FALLBACK = 'file';
const FOLDER_FALLBACK = 'folder';

function baseName(path: string): string {
  return (path.split(/[\\/]/).filter(Boolean).pop() ?? path).toLowerCase();
}

/** The icon id for a file name or path: exact file name first, then the longest extension (`d.ts` before `ts`), else a plain file. */
export function fileIconId(path: string): string {
  const name = baseName(path);
  const exact = M.file[name];
  if (exact) return exact;
  if (name.startsWith('.env')) return M.file['.env'] ?? M.ext['env'] ?? FILE_FALLBACK;
  // `a.test.ts` -> try `test.ts`, then `ts`. A leading dot is part of the name, not an extension.
  const parts = name.replace(/^\./, '').split('.');
  for (let i = 1; i < parts.length; i++) {
    const hit = M.ext[parts.slice(i).join('.')];
    if (hit) return hit;
  }
  return FILE_FALLBACK;
}

/** The icon id for a folder name or path. `.github`, `_github` and `github` are the same folder. */
export function folderIconId(path: string, open = false): string {
  const name = baseName(path);
  const plain = name.replace(/^[._]+/, '').replace(/_+$/, '');
  const id = M.folder[name] ?? M.folder[plain] ?? FOLDER_FALLBACK;
  return open ? `${id}-open` : id;
}

/** True when this icon has its own picture for the light themes (it would be too pale on white). */
export function hasLightVariant(id: string): boolean {
  return M.light.includes(id);
}

type Svgs = Readonly<Record<string, string>>;
let svgs: Svgs | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadIconSvgs(): Promise<void> {
  loading ??= import('./svgs.generated').then(({ ICON_SVGS }) => {
    svgs = ICON_SVGS;
    for (const l of listeners) l();
  });
  return loading;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  void loadIconSvgs();
  return () => listeners.delete(l);
}

/** The pictures, or null until they have loaded. */
export function useIconSvgs(): Svgs | null {
  return useSyncExternalStore(subscribe, () => svgs, () => null);
}

/** The picture for an icon id. A folder with no open picture shows its closed one; an unknown id shows the plain icon. */
export function iconSvg(all: Svgs, id: string, light = false): string {
  const pick = (k: string) => (light ? all[`${k}_light`] : undefined) ?? all[k];
  return pick(id) ?? pick(id.replace(/-open$/, '')) ?? pick(id.startsWith('folder') ? FOLDER_FALLBACK : FILE_FALLBACK) ?? '';
}
