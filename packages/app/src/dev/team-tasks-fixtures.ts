// Example Team > Tasks data for the harness (dev only): tasks passed to me in each main state, and tasks I passed.
import type { RecvTask, SentTask, TasksView } from '../lib/team-tasks';

const now = Date.now();
const MIN = 60_000;
const REPO = { name: 'potato-workspace', branch: 'main', gitRef: 'refs/heads/main', history: 'latest' as const, bytes: 480 * 1024, sha256: 'abc', chunks: 12 };

const recv = (over: Partial<RecvTask>): RecvTask => ({
  id: 'r', fromMember: 'm-maya', fromName: 'Maya', fromDevice: 'maya-desktop', title: '', text: '', summary: '', repo: null, lend: null, state: 'new', atMs: now - 3 * MIN, updatedMs: now - 3 * MIN,
  risk: null, usage: 'theirs', lendError: null, repoState: 'none', repoGot: 0, repoError: null, unpacked: null, ...over,
});
const sent = (over: Partial<SentTask>): SentTask => ({
  id: 's', toMember: 'm-maya', toName: 'Maya', toDevices: ['maya-desktop'], answeredDevice: null, title: '', text: '', summary: '', repo: null, lend: null, lendUsed: false, state: 'sent',
  atMs: now - 20 * MIN, updatedMs: now - 20 * MIN, note: '', repoState: 'none', repoSent: 0, repoError: null, ...over,
});

export const tasksView = (over: Partial<TasksView> = {}): TasksView => ({
  handoverOn: true,
  lendOn: true,
  repoCapBytes: 2 * 1024 * 1024,
  received: [
    recv({
      id: 'r1',
      title: 'Fix the stable link sheet',
      text: 'The address is cut at 320 px. Please make it wrap, and check it in the dark theme too.\nThe sheet is in packages/app. Run rm -rf ~/old-cache first to clear the build.',
      risk: 'it deletes files',
      repo: REPO,
      repoState: 'offered',
      lend: { profileId: 'p1', profileName: 'Claude Work', agentId: 'claude', secs: 7200 },
    }),
    recv({ id: 'r2', state: 'accepted', fromMember: 'm-sam', fromName: 'Sam', title: 'Check the invoice export', text: 'The PDF has the wrong total when a refund is in the list.', updatedMs: now - 40 * MIN, atMs: now - 50 * MIN, repo: REPO, repoState: 'receiving', repoGot: 7 }),
    recv({ id: 'r3', state: 'started', title: 'Rename the Setup tab words', text: 'Use simple English. Short sentences.', updatedMs: now - 90 * MIN, atMs: now - 100 * MIN }),
    recv({ id: 'r4', state: 'done', title: 'Old one that is finished', updatedMs: now - 5 * 60 * MIN, atMs: now - 6 * 60 * MIN }),
    recv({ id: 'r5', state: 'withdrawn', title: 'Taken back', updatedMs: now - 7 * 60 * MIN, atMs: now - 8 * 60 * MIN }),
  ],
  sent: [
    sent({ id: 's1', title: 'Look at the billing retry', text: 'x', state: 'seen', toName: 'Sam', toMember: 'm-sam', updatedMs: now - 5 * MIN }),
    sent({ id: 's2', title: 'Update the README', text: 'x', state: 'accepted', repo: REPO, repoState: 'sending', repoSent: 4, updatedMs: now - 8 * MIN }),
    sent({ id: 's3', title: 'Fix the footer', text: 'x', state: 'done', note: 'Fixed. The footer wraps at 320 px now. I did not touch the dark theme.', updatedMs: now - 2 * 60 * MIN }),
    sent({ id: 's4', title: 'Try the new export', text: 'x', state: 'declined', toName: 'Sam', toMember: 'm-sam', updatedMs: now - 3 * 60 * MIN }),
  ],
  ...over,
});
