// Example answers of `GET /phone/done` and `GET /phone/helpers` for the phone harness and the screen tests.
import type { PhoneDoneReply, PhoneHelpersReply } from '../lib/bridge-types';
import { PHONE_PANES } from './phone-fixtures';

const MIN = 60_000;

export function phoneDoneReply(now = Date.now()): PhoneDoneReply {
  const [first, second, third] = PHONE_PANES;
  return {
    now,
    since: now - 12 * 60 * MIN,
    rows: [
      { paneId: first.id, agent: 'claude', endedAtMs: now - 6 * MIN, files: { count: 12, added: 1204, deleted: 998 }, checks: '2/2 passed', sentence: 'Edited 12 files.' },
      { paneId: second.id, agent: 'codex', endedAtMs: now - 41 * MIN, files: { count: 0, added: 0, deleted: 0 }, checks: null, sentence: 'Answered a question.' },
      { paneId: third.id, agent: 'claude', endedAtMs: now - 95 * MIN, files: { count: 3, added: 48, deleted: 12 }, checks: null, sentence: 'Edited 3 files.' },
    ],
  };
}

export const PHONE_HELPERS: PhoneHelpersReply = {
  max: 4,
  helpers: [
    { id: 'sb-1', name: 'Reviewer', agent: 'claude', model: null, folder: 'billing-service', state: 'ready', note: null },
    { id: 'sb-2', name: 'Docs helper', agent: 'codex', model: null, folder: 'docs-site', state: 'ready', note: null },
    { id: 'sb-3', name: 'Night builder', agent: 'claude', model: null, folder: 'potato-workspace', state: 'busy', note: null },
  ],
};
