// Runs before every test file. Terminals are shown, as the app did before "Show terminals" existed; a test of the hidden
// state calls `forceShowTerminals(false)` (and puts it back with `forceShowTerminals(true)`).
import { forceShowTerminals } from './lib/showTerminals';

forceShowTerminals(true);
