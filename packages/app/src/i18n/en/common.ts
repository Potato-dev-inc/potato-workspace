// English messages: common. Keys are dotted (`common.something`). Plural: `<key>_one` / `<key>_other`.
export const common = {
  'common.open': 'Open',
  'common.dismiss': 'Dismiss',
  'common.undo': 'Undo',
  'common.reopen': 'Reopen',
  'common.tryAgain': 'Try again',
  'common.copyDetails': 'Copy details',
  'common.copied': 'Copied',
  'common.otherWays': 'Other ways',
  'common.errorTitle': 'Something went wrong here',
  'common.errorBody': 'The rest of the app is fine. Try again, and if it keeps happening, copy the details and send them to us.',
  'common.err.generic': 'Something went wrong. Try again.',
  'common.err.trustDeclined': 'You chose not to trust this folder, so nothing was sent.',
  'common.err.agentExited': 'The agent closed unexpectedly. Your files are as it left them.',
  'common.err.notInstalled': 'That agent is not installed on this PC yet.',
  'common.err.notReady': 'The agent was not ready, so nothing was typed.',
  'common.err.promptNotSubmitted': 'The task was typed, but the agent did not start on it.',
} as const;
