import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const SHIM = fileURLToPath(new URL('./src/lib/tauri-core.ts', import.meta.url)).replaceAll('\\', '/');

/** Sends every `invoke` import (ours, the plugins', and the event module's own `./core.js`) to src/lib/tauri-core.ts, which
 *  wraps the real one. The shim itself is left alone so it reaches the real package (no alias loop). Nothing touches the
 *  read-only Tauri internals. */
export function tauriCoreShim(): Plugin {
  return {
    name: 'tauri-core-shim',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const from = importer.replaceAll('\\', '/').split('?')[0];
      if (from === SHIM) return null;
      if (source === '@tauri-apps/api/core') return SHIM;
      if (/^\.\/core(\.js)?$/.test(source) && from.includes('/@tauri-apps/api/')) return SHIM;
      return null;
    },
  };
}
