// Runs before every test file. Terminals are shown, as the app did before "Show terminals" existed; a test of the hidden
// state calls `forceShowTerminals(false)` (and puts it back with `forceShowTerminals(true)`).
import { beforeEach } from 'vitest';
import { chatKept, chatStores, chatTuning } from './hooks/chatTuning';
import { forceShowTerminals } from './lib/showTerminals';

forceShowTerminals(true);
// A chat lets go of its reader at once and never waits for another one in a test (the app waits a moment).
chatTuning.graceMs = 0;
chatTuning.settleMs = 0;

// The Setup list keeps its last answer on this computer (Settings > Setup). A test never inherits the one before it.
beforeEach(() => {
  chatStores.clear();
  chatKept.clear();
  try {
    globalThis.localStorage?.removeItem('pm.setupcheck.rows.v1');
  } catch {
    /* no storage in this environment */
  }
});
