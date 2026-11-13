// Every word the first-run welcome shows. Plain English, the UX-PHASE1 section 0.3 word list: "separate
// copy", "Sign in", "Set up agents", "Undo", "History", "Receipt"; never worktree, account, quota, hooks,
// doctor, checkpoint. Sentences stay under 16 words and a card under 4 sentences (copy.test.ts checks).
import { formatKey, isMacPlatform } from '../../lib/shortcuts';
import { t } from '../../i18n';
import type { Look, StepId } from './model';

/** Names in a sentence: "A and B" in English. */
const joinNames = (names: string[]): string => names.join(t('firstRun.and'));

/** The demo for a main agent that has a second agent to ask. It names our tool, so the agent does not run the other CLI itself. It never asks for the read_only flag: that needs a hidden run, which "Always show them" refuses, and a new user would meet a card about it. */
export const demoPrompt = (helper: string): string =>
  `Use the potato-workspace run_agent tool to have ${helper} review the last commit in this project and list 3 risks. Tell ${helper} not to change any files. Show me its answer.`;

/**
 * The suggested first task, word for word what Rust sends (`first_run::TASK_PROMPT`; copy.test.ts reads
 * the Rust file and checks they match). It asks for words, never for a change.
 */
export const TASK_PROMPT =
  'Read this project and tell me, in a few plain sentences, what it does and how it is laid out. Change nothing: do not create, edit, move or delete any file.';

export const T = {
  // Shell
  get title() { return t('firstRun.title'); },
  stepOf: (n: number, total: number) => t('firstRun.stepOf', { n, total }),
  get skipStep() { return t('firstRun.skipStep'); },
  get later() { return t('firstRun.later'); },
  get back() { return t('firstRun.back'); },
  get next() { return t('firstRun.next'); },
  get reopenNote() { return t('firstRun.reopenNote', { key: formatKey('Mod+K', isMacPlatform()) }); },
  get pausedBar() { return t('firstRun.pausedBar'); },
  get pausedButton() { return t('firstRun.pausedButton'); },

  // 1. Your agents (with the look, folded in)
  get agentsTitle() { return t('firstRun.agentsTitle'); },
  get agentsLead() { return t('firstRun.agentsLead'); },
  get agentFound() { return t('firstRun.agentFound'); },
  get agentLogin() { return t('firstRun.agentLogin'); },
  get agentMissing() { return t('firstRun.agentMissing'); },
  get agentChecking() { return t('firstRun.agentChecking'); },
  get agentInstall() { return t('firstRun.agentInstall'); },
  get agentSignIn() { return t('firstRun.agentSignIn'); },
  get agentsMore() { return t('firstRun.agentsMore'); },
  get agentsWarm() { return t('firstRun.agentsWarm'); },
  agentsReady: (n: number) => t('firstRun.agentsReady', { count: n }),
  get agentsNone() { return t('firstRun.agentsNone'); },
  get howDoYouWork() { return t('firstRun.howDoYouWork'); },
  get howHint() { return t('firstRun.howHint'); },
  looks: {
    code: { get label() { return t('firstRun.looks.code.label'); }, get hint() { return t('firstRun.looks.code.hint'); } },
    ai: { get label() { return t('firstRun.looks.ai.label'); }, get hint() { return t('firstRun.looks.ai.hint'); } },
    none: { get label() { return t('firstRun.looks.none.label'); }, get hint() { return t('firstRun.looks.none.hint'); } },
  } satisfies Record<Look, { label: string; hint: string }>,
  get noteCode() { return t('firstRun.noteCode'); },
  get noteSimple() { return t('firstRun.noteSimple'); },

  // 2. Connect
  get connectTitle() { return t('firstRun.connectTitle'); },
  get connectLead() { return t('firstRun.connectLead'); },
  get connectLooking() { return t('firstRun.connectLooking'); },
  get connectDone() { return t('firstRun.connectDone'); },
  get connectDoneRestart() { return t('firstRun.connectDoneRestart'); },
  connectButton: (names: string[]) => t('firstRun.connectButton', { names: joinNames(names) }),
  get connectNone() { return t('firstRun.connectNone'); },
  connectSummary: (names: string[]) => t('firstRun.connectSummary', { names: joinNames(names) }),
  get connectFilesTitle() { return t('firstRun.connectFilesTitle'); },
  get connectFilesNone() { return t('firstRun.connectFilesNone'); },
  get connectFileAdd() { return t('firstRun.connectFileAdd'); },
  get connectFileFix() { return t('firstRun.connectFileFix'); },
  connectPointsTo: (old: string) => t('firstRun.connectPointsTo', { old }),
  get connectFixSettings() { return t('firstRun.connectFixSettings'); },
  get connectDevWarn() { return t('firstRun.connectDevWarn'); },
  get whyAgents() { return t('firstRun.whyAgents'); },
  get whyConnect() { return t('firstRun.whyConnect'); },
  get whyProject() { return t('firstRun.whyProject'); },
  get whyTask() { return t('firstRun.whyTask'); },
  get connectAdding() { return t('firstRun.connectAdding'); },
  get connectUndo() { return t('firstRun.connectUndo'); },
  get connectUndoing() { return t('firstRun.connectUndoing'); },
  get connectUndone() { return t('firstRun.connectUndone'); },
  get connectFailed() { return t('firstRun.connectFailed'); },
  get connectBackups() { return t('firstRun.connectBackups'); },

  // 3. Project
  get projectTitle() { return t('firstRun.projectTitle'); },
  get projectLead() { return t('firstRun.projectLead'); },
  get recent() { return t('firstRun.recent'); },
  get noRecent() { return t('firstRun.noRecent'); },
  get chooseFolder() { return t('firstRun.chooseFolder'); },
  get checking() { return t('firstRun.checking'); },
  get tooBroad() { return t('firstRun.tooBroad'); },
  get tooBig() { return t('firstRun.tooBig'); },
  get missing() { return t('firstRun.missing'); },
  get failedFolder() { return t('firstRun.failedFolder'); },
  get needsGitTitle() { return t('firstRun.needsGitTitle'); },
  get needsGitBody() { return t('firstRun.needsGitBody'); },
  get setUpGit() { return t('firstRun.setUpGit'); },
  get gitWorking() { return t('firstRun.gitWorking'); },
  gitFiles: (n: number) => t('firstRun.gitFiles', { count: n }),
  get gitTooBig() { return t('firstRun.gitTooBig'); },
  get projectChosen() { return t('firstRun.projectChosen'); },
  get remove() { return t('firstRun.remove'); },

  // 4. Try it
  get taskTitle() { return t('firstRun.taskTitle'); },
  get taskLead() { return t('firstRun.taskLead'); },
  get taskWhat() { return t('firstRun.taskWhat'); },
  taskSummary: (agent: string, other: string | null) =>
    other ? t('firstRun.taskSummaryWith', { agent, other }) : t('firstRun.taskSummaryAlone', { agent }),
  get taskExact() { return t('firstRun.taskExact'); },
  taskStart: (agent: string) => t('firstRun.taskStart', { agent }),
  get taskStarting() { return t('firstRun.taskStarting'); },
  taskOpening: (agent: string) => t('firstRun.taskOpening', { agent }),
  get taskPaneFailed() { return t('firstRun.taskPaneFailed'); },
  taskWorking: (agent: string) => t('firstRun.taskWorking', { agent }),
  get taskHelpers() { return t('firstRun.taskHelpers'); },
  get taskNoHelper() { return t('firstRun.taskNoHelper'); },
  get taskHelperWorking() { return t('firstRun.taskHelperWorking'); },
  get taskHelperDone() { return t('firstRun.taskHelperDone'); },
  get taskHelperNeeds() { return t('firstRun.taskHelperNeeds'); },
  get taskHelperFailed() { return t('firstRun.taskHelperFailed'); },
  get taskDoneTitle() { return t('firstRun.taskDoneTitle'); },
  get taskDoneBody() { return t('firstRun.taskDoneBody'); },
  taskTime: (secs: number) =>
    secs < 60 ? t('firstRun.taskTimeSecs', { n: secs }) : t('firstRun.taskTimeMins', { m: Math.floor(secs / 60), s: secs % 60 }),
  get taskAlone() { return t('firstRun.taskAlone'); },
  get taskAloneBody() { return t('firstRun.taskAloneBody'); },
  get taskAgain() { return t('firstRun.taskAgain'); },
  taskNoMcp: (agent: string) => t('firstRun.taskNoMcp', { agent }),
  get taskNoMcpHow() { return t('firstRun.taskNoMcpHow'); },
  get taskNoMcpDev() { return t('firstRun.taskNoMcpDev'); },
  get taskNeedsAgent() { return t('firstRun.taskNeedsAgent'); },
  get taskNeedsProject() { return t('firstRun.taskNeedsProject'); },
  taskAsking: (agent: string) => t('firstRun.taskAsking', { agent }),
  get approvalTip() { return t('firstRun.approvalTip'); },
  get openPane() { return t('firstRun.openPane'); },
  get taskWarm() { return t('firstRun.taskWarm'); },
  get taskCold() { return t('firstRun.taskCold'); },
  get taskSolo() { return t('firstRun.taskSolo'); },

  // More you can set up
  get moreTitle() { return t('firstRun.moreTitle'); },
  get morePhone() { return t('firstRun.morePhone'); },
  get morePhoneBody() { return t('firstRun.morePhoneBody'); },
  get morePack() { return t('firstRun.morePack'); },
  get morePackBody() { return t('firstRun.morePackBody'); },
  get morePackDone() { return t('firstRun.morePackDone'); },
  get moreOpen() { return t('firstRun.moreOpen'); },
  get moreBack() { return t('firstRun.moreBack'); },

  // Phone
  get phoneTitle() { return t('firstRun.phoneTitle'); },
  get phoneLead() { return t('firstRun.phoneLead'); },
  get phoneNote() { return t('firstRun.phoneNote'); },

  // Pack
  get packTitle() { return t('firstRun.packTitle'); },
  get packLead() { return t('firstRun.packLead'); },
  packFound: (names: string[]) => (names.length ? t('firstRun.packFound', { names: names.join(', ') }) : t('firstRun.packNone')),
  get packReview() { return t('firstRun.packReview'); },
  get looking() { return t('firstRun.looking'); },

  // Done
  get doneTitle() { return t('firstRun.doneTitle'); },
  get doneLead() { return t('firstRun.doneLead'); },
  get doneLookTitle() { return t('firstRun.doneLookTitle'); },
  get tipKeys() { return formatKey('Mod+K', isMacPlatform()); },
  get tipKeysBody() { return t('firstRun.tipKeysBody'); },
  get tipInbox() { return t('firstRun.tipInbox'); },
  get tipInboxBody() { return t('firstRun.tipInboxBody'); },
  get tipHistory() { return t('firstRun.tipHistory'); },
  get tipHistoryBody() { return t('firstRun.tipHistoryBody'); },
  get doneButton() { return t('firstRun.doneButton'); },
  stepNames: {
    get agents() { return t('firstRun.stepNames.agents'); },
    get connect() { return t('firstRun.stepNames.connect'); },
    get project() { return t('firstRun.stepNames.project'); },
    get task() { return t('firstRun.stepNames.task'); },
    get done() { return t('firstRun.stepNames.done'); },
  } satisfies Record<StepId, string>,

  // Palette and Settings
  get paletteTitle() { return t('firstRun.paletteTitle'); },
  get paletteDesc() { return t('firstRun.paletteDesc'); },
  get settingLabel() { return t('firstRun.settingLabel'); },
  get settingHint() { return t('firstRun.settingHint'); },
  get settingButton() { return t('firstRun.settingButton'); },
} as const;

/** Every fixed sentence, for the language test. The three look labels are the founder's wording. */
export function ownStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown, key = ''): void => {
    if (typeof value === 'string') {
      if (key !== 'label') out.push(value);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(T);
  out.push(
    T.stepOf(2, 5),
    T.agentsReady(1),
    T.agentsReady(3),
    T.gitFiles(1),
    T.gitFiles(12),
    T.taskWorking('Claude'),
    T.taskAsking('Codex'),
    T.taskStart('Claude'),
    T.taskSummary('Claude', 'Codex'),
    T.taskSummary('Claude', null),
    T.taskOpening('Claude'),
    T.taskTime(95),
    T.taskAlone,
    T.taskAloneBody,
    T.taskNoMcp('Claude'),
    T.taskNoMcpHow,
    T.taskNoMcpDev,
    T.connectButton(['Claude Code', 'Codex']),
    T.connectSummary(['Claude Code', 'Codex']),
    T.connectPointsTo('the old program'),
    T.packFound(['Claude', 'Codex']),
    T.packFound([]),
  );
  return out;
}
