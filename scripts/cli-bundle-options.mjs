/**
 * esbuild options for the standalone CLI bundle. The bundle has no package.json next to it, so the CLI's
 * version is written into it here (read as `__CLI_VERSION__` in packages/cli/src/index.ts).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function cliBundleOptions(root, outfile) {
  const cliPackage = JSON.parse(readFileSync(resolve(root, 'packages/cli/package.json'), 'utf-8'));
  return {
    entryPoints: [resolve(root, 'packages/cli/src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    define: { __CLI_VERSION__: JSON.stringify(String(cliPackage.version)) },
    outfile,
    logLevel: 'info',
  };
}
