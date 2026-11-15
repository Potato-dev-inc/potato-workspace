// Example Team page data for the harness (dev only): three people (one shares the project, one is away), one lend out, one borrowed, one request.
import { GRANT_IN, GRANT_OUT, REQUEST_MAYA, lendState } from './lend-fixtures';
import { teamState } from './team-fixtures';
import type { PresenceView } from '../lib/team';

const now = Date.now();
const MIN = 60_000;

export const PRESENCE: PresenceView[] = [
  { member: 'm-maya', state: 'here', atMs: now - 5_000, sinceMs: now - 40 * MIN, project: 'billing-service', title: 'Invoice PDF export', running: 2, waiting: 1 },
  { member: 'm-sam', state: 'away', atMs: now - 10_000, sinceMs: now - 12 * MIN, project: null, title: null, running: 0, waiting: 0 },
];

export const teamPageState = () => teamState({ presence: PRESENCE, share: { level: 'here', exclude: [] } });
export const teamPageLend = () => lendState({ grants: [GRANT_OUT, GRANT_IN], requests_in: [REQUEST_MAYA] });
