import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node by default: a test that needs `document` or `window` says so on its first line with
    // `// @vitest-environment jsdom`. Building a jsdom window for every file cost about 40 % of a full run
    // (see docs/DEV-SPEED.md); most of the files never touch the DOM.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'vite-bridge-proxy.test.ts'],
    // vmThreads builds the jsdom window inside a vm context instead of a fresh worker per file, which cut
    // jsdom setup by about two thirds in the sister project. `npm run test:safe` falls back to forks.
    pool: 'vmThreads',
    css: false,
  },
});
