import { EXAMPLE_PANES, PANE_CLAUDE, PANE_CODEX } from '../fixtures';
import { teamState } from '../team-fixtures';
import type { Question } from '../../lib/questions';
import type { HarnessScenario } from '../types';
import { INBOX_TURNS } from './inbox-1116-clear';

// Inbox 1.1.1, two things need you: the calm line is swapped for the cards, the rest stays where it was.
const now = Date.now();
const questions: Question[] = [
  {
    id: 'q-table',
    agent: 'Claude',
    pane_id: PANE_CLAUDE,
    question: 'Which table style: borders like Word, or plain?',
    choices: [
      { id: 'word', label: 'Like Word' },
      { id: 'plain', label: 'Plain' },
    ],
    allow_free_text: false,
    urgency: 'normal',
    created_at_ms: now - 6 * 60_000,
    expires_at_ms: now + 600_000,
    state: 'pending',
  },
  {
    id: 'q-push',
    agent: 'Codex',
    pane_id: PANE_CODEX,
    question: 'Push the branch fix/usage-dupes to origin?',
    choices: [
      { id: 'yes', label: 'Push' },
      { id: 'no', label: 'No' },
    ],
    allow_free_text: false,
    urgency: 'normal',
    created_at_ms: now - 2 * 60_000,
    expires_at_ms: now + 600_000,
    state: 'pending',
  },
];

const s: HarnessScenario = {
  name: 'inbox-1116-needs',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  panes: EXAMPLE_PANES.map((p) => ({ ...p, status: 'idle' as const })),
  questions,
  turnSummaries: INBOX_TURNS,
  team: teamState(),
  after: async (dom) => {
    await dom.waitFor('[data-testid="team-activity"] [data-team-activity]');
    await dom.sleep(300);
  },
};
export default s;
