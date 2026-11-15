// Runs before every test file. Terminals are shown, as the app did before "Show terminals" existed; a test of the hidden
// state calls `forceShowTerminals(false)` (and puts it back with `forceShowTerminals(true)`).
import { beforeEach } from 'vitest';
import { forceShowTerminals } from './lib/showTerminals';

forceShowTerminals(true);

// The Setup list keeps its last answer on this computer (Settings > Setup). A test never inherits the one before it.
beforeEach(() => {
  try {
    globalThis.localStorage?.removeItem('pm.setupcheck.rows.v1');
  } catch {
    /* no storage in this environment */
  }
});
