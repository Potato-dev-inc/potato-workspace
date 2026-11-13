// English messages: inboxCards. Keys are dotted (`inboxCards.something`). Plural: `<key>_one` / `<key>_other`.
export const inboxCards = {
  // Shared by most Inbox cards.
  'inboxCards.dismiss': 'Dismiss',
  'inboxCards.open': 'Open',
  'inboxCards.send': 'Send',
  'inboxCards.notNow': 'Not now',
  'inboxCards.lookFirst': 'Look first',
  'inboxCards.endsIn': 'Ends in {time} if you do not answer.',
  'inboxCards.details': 'Details',
  'inboxCards.hideDetails': 'Hide details',
  'inboxCards.showDetails': 'Show details',
  'inboxCards.moreOptions': 'More options',
  'inboxCards.labelled': '{label}: {text}',
  'inboxCards.agent': 'Agent',
  'inboxCards.runs': 'Runs:',

  // QuestionCard
  'inboxCards.question.alwaysUse': 'Always use this',
  'inboxCards.question.orType': 'Or type an answer',
  'inboxCards.question.typeAnswer': 'Type an answer',
  'inboxCards.question.yourAnswer': 'Your answer',

  // StuckCard
  'inboxCards.stuck.hint': 'Give it a hint',
  'inboxCards.stuck.interrupt': 'Interrupt',
  'inboxCards.stuck.askAnother': 'Ask another agent',

  // PaneApprovalCard and ApprovalPrompt
  'inboxCards.approval.waiting': 'Waiting for your answer',
  'inboxCards.approval.ariaLabel': 'Approval request',
  'inboxCards.stalled': 'That answer did not go through. Claude is still asking. Press your answer again.',

  // ConsentCard
  'inboxCards.consent.anotherAgent': 'another agent',
  'inboxCards.consent.unknownAgent': 'Unknown agent',
  'inboxCards.consent.notStarted': 'It did not start this pane.',
  'inboxCards.consent.wantsToAnswer': 'It wants to answer: "{asked}".',
  'inboxCards.consent.controlTitle': 'Allow {who} to control {target}?',
  'inboxCards.consent.answerTitle': 'Allow {who} to answer a question in {target}?',
  'inboxCards.consent.thatWindow': 'that window',
  'inboxCards.consent.deny': 'Deny',
  'inboxCards.consent.allowOnce': 'Allow once',
  'inboxCards.consent.alwaysHere': 'Always allow here',

  // LimitCard
  'inboxCards.limit.otherAgent': 'Other agent…',
  'inboxCards.limit.startAs': 'Start {name} as {label}',
  'inboxCards.limit.thisAgent': 'this agent',
  'inboxCards.limit.wakeOn': 'Wake {name} on…',

  // IssueCard
  'inboxCards.issue.header': 'GitHub issue',
  'inboxCards.issue.headerNumber': 'GitHub issue #{n}',
  'inboxCards.issue.byLine': 'Labeled by {labeler} · written by {writer}',
  'inboxCards.issue.held': "Potato Workspace won't push this. Check the copy yourself.",
  'inboxCards.issue.openDraft': 'Open draft PR',
  'inboxCards.issue.throwAway': 'Throw away',
  'inboxCards.issue.ignore': 'Ignore this issue',
  'inboxCards.issue.startFallback': 'Start the run',
  'inboxCards.issue.showText': 'Show issue text',
  'inboxCards.issue.hideText': 'Hide issue text',
  'inboxCards.issue.textLabel': 'The text the agent gets',

  // CiFixCard
  'inboxCards.ci.failed': 'CI failed',
  'inboxCards.ci.failedOn': 'CI failed on #{n}.',
  'inboxCards.ci.fix': 'CI fix',
  'inboxCards.ci.try': 'Try {n} of {total}',
  'inboxCards.ci.logSize': 'Log: {size}',
  'inboxCards.ci.snapshot': 'Snapshot {sha}',
  'inboxCards.ci.logFailed': "Couldn't load the log.",
  'inboxCards.ci.logLoading': 'Loading the log...',
  'inboxCards.ci.logGone': 'The log is gone. The fix has ended.',
  'inboxCards.ci.noLines': 'No log lines were kept for this check.',
  'inboxCards.ci.logLabel': 'The log the agent gets',
  'inboxCards.ci.failingChecks': 'Failing checks',
  'inboxCards.ci.fixFallback': 'Ask the agent to fix',
  'inboxCards.ci.push': 'Push fix',
  'inboxCards.ci.dontPush': "Don't push",
  'inboxCards.ci.stopWatching': 'Stop watching this PR',
  'inboxCards.ci.showLog': 'Show log',
  'inboxCards.ci.hideLog': 'Hide log',
  'inboxCards.ci.held': "Potato Workspace won't push this fix. Check the copy yourself.",

  // AskNotices
  'inboxCards.ask.title': 'Answer from {agent}',
  'inboxCards.ask.noAnswer': 'The agent could not answer.',
  'inboxCards.ask.listLabel': 'Answers from your agents',

  // HiddenRuns
  'inboxCards.hidden.title': '{name} helper ran with no window',
  'inboxCards.hidden.listLabel': 'Helpers that ran with no window',

  // ImportChatsCard
  'inboxCards.import.title': 'Bring your chats here',
  'inboxCards.import.body': 'Bring the chats your other agents kept on this PC. Nothing leaves this computer.',
  'inboxCards.import.bring': 'Bring my chats',
  'inboxCards.import.listLabel': 'Old chats',

  // CanaryNotices
  'inboxCards.canary.listLabel': 'Notes about your agents',

  // lib/attention-copy.ts (the phone card and its queue)
  'inboxCards.attention.changed': 'This question changed. Look again.',
  'inboxCards.attention.gone': 'This question has gone. {agent} moved on.',
  'inboxCards.attention.alreadyPc': 'Already answered on your PC: {label}.',
  'inboxCards.attention.alreadyYou': 'Already answered by you: {label}.',
  'inboxCards.attention.alreadyPhone': 'Already answered from {device}: {label}.',
  'inboxCards.attention.answered': '{label} · {clock} · from this phone',
  'inboxCards.attention.failed': "Couldn't send your answer to {agent}. Nothing was typed.",
  'inboxCards.attention.offline': "Can't reach your PC. Your answer wasn't sent.",
  'inboxCards.attention.lost': "Didn't hear back from your PC. Your answer may not have arrived.",
  'inboxCards.attention.sending': 'Sending',
  'inboxCards.attention.sendingToPc': 'Sending to your PC',
  'inboxCards.attention.stillSending': "Still sending. Your PC hasn't confirmed yet.",
  'inboxCards.attention.watchOnly': 'This phone can watch only. To answer here, allow it on your PC: Settings › Phone.',
  'inboxCards.attention.controlOnly': "This phone can't do that. Allow it on your PC: Settings › Phone.",
  'inboxCards.attention.provenanceScreen': 'Read from the screen',
  'inboxCards.attention.caution': 'Read this before you allow it. It may be hard to undo.',
  'inboxCards.attention.noPromptTitle': '{agent} is waiting for you',
  'inboxCards.attention.noPromptBody': "Potato Workspace can't read this question. Open the pane to answer it.",
  'inboxCards.attention.signInTitle': '{agent} needs you on your PC.',
  'inboxCards.attention.signInBody': "It's showing a sign-in screen. Potato Workspace won't answer it for you.",
  'inboxCards.attention.expired': '{agent} stopped waiting at {clock}.',
  'inboxCards.attention.queue_one': '1 more waiting',
  'inboxCards.attention.queue_other': '{count} more waiting',
  'inboxCards.attention.emptyTitle': 'Nothing needs you',
  'inboxCards.attention.emptyBody': 'Agents that stop to ask will show up here.',
  'inboxCards.attention.dealtWith': 'That request has been dealt with.',
  'inboxCards.attention.openPane': 'Open pane',
  'inboxCards.attention.tryAgain': 'Try again',
  'inboxCards.attention.lookAgain': 'Look again',
  'inboxCards.attention.answeredWord': 'Answered',
  'inboxCards.attention.anotherPhone': 'another phone',
  'inboxCards.attention.theAgent': 'The agent',

  // Time words in the cards (lib/attention-copy.ts)
  'inboxCards.age.justNow': 'just now',
  'inboxCards.age.minutes': '{n} min',
  'inboxCards.age.hours': '{n} h',
  'inboxCards.age.hoursMinutes': '{h} h {m} min',
  'inboxCards.age.seconds': '{n} s',
} as const;
