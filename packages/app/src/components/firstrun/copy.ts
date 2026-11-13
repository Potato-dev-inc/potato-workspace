// Every word the first-run welcome shows. Plain English, the UX-PHASE1 section 0.3 word list: "separate
// copy", "Sign in", "Set up agents", "Undo", "History", "Receipt"; never worktree, account, quota, hooks,
// doctor, checkpoint. Sentences stay under 16 words and a card under 4 sentences (copy.test.ts checks).
import { formatKey, isMacPlatform } from '../../lib/shortcuts';
import { SIGN_IN } from '../../lib/glossary';
import type { Look, StepId } from './model';

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
  title: 'Welcome to Potato Workspace',
  stepOf: (n: number, total: number) => `Step ${n} of ${total}`,
  skipStep: 'Skip for now',
  later: 'Later',
  back: 'Back',
  next: 'Continue',
  reopenNote: `Press Esc to leave setup. You can open it again from ${formatKey('Mod+K', isMacPlatform())}, or from Settings.`,
  pausedBar: 'Setup is paused. Finish in the window, then come back.',
  pausedButton: 'Back to setup',

  // 1. Your agents (with the look, folded in)
  agentsTitle: 'Your agents',
  agentsLead: 'Agents do the work for you. Potato Workspace found these.',
  agentFound: 'Ready',
  agentLogin: SIGN_IN.needed,
  agentMissing: 'Not installed',
  agentChecking: 'Looking…',
  agentInstall: 'Install',
  agentSignIn: SIGN_IN.action,
  agentsMore: 'Help with an agent',
  agentsWarm: 'Claude and Codex are kept ready so they start fast. You can change this in Settings.',
  agentsReady: (n: number) => (n === 1 ? '1 agent is ready. You can go on.' : `${n} agents are ready. You can go on.`),
  agentsNone: 'No agent is ready yet. Install one or sign in, or skip for now.',
  howDoYouWork: 'How do you work?',
  howHint: 'You can change this later in Settings.',
  looks: {
    code: { label: 'I write code', hint: 'The full cockpit: panes, changes and a terminal.' },
    ai: { label: 'I build with AI, not much code', hint: 'Fewer buttons and plain words. Every task runs in a separate copy.' },
    none: { label: "I don't code", hint: 'Fewer buttons and plain words. Your own files stay safe.' },
  } satisfies Record<Look, { label: string; hint: string }>,
  noteCode: 'You get the full cockpit. Simple mode is in Settings, under General.',
  noteSimple: 'Simple mode is on. Switch it off any time in Settings, under General.',

  // 2. Connect
  connectTitle: 'Connect your agents',
  connectLead: 'This lets your agent hand work to other agents through Potato Workspace.',
  connectLooking: 'Looking at your agents…',
  connectDone: 'Connected. Your agents can use Potato Workspace now.',
  connectDoneRestart: 'Restart agents that are already open to pick it up.',
  connectButton: (names: string[]) => `Add Potato Workspace to ${names.join(' and ')}`,
  connectNone: 'No agent was found to connect. Go back to Your agents, or skip.',
  connectSummary: (names: string[]) => `This adds one entry to the settings of ${names.join(' and ')}.`,
  connectFilesTitle: 'These files change',
  connectFilesNone: 'Nothing changes. Your agents are already connected.',
  connectFileAdd: 'one entry is added',
  connectFileFix: 'one entry is fixed',
  connectPointsTo: (old: string) => `points to this app's MCP instead of ${old}`,
  connectFixSettings: 'adds the settings that are missing from the entry',
  connectDevWarn: 'This is a dev build. The agent would point at this dev copy, not an installed app.',
  whyAgents: 'Continue turns on when one agent is ready.',
  whyConnect: 'Continue turns on after you add Potato Workspace. Or skip for now.',
  whyProject: 'Continue turns on when you pick a project folder that uses git.',
  whyTask: 'Continue turns on after the first task runs. Or skip it.',
  connectAdding: 'Adding…',
  connectUndo: 'Undo',
  connectUndoing: 'Undoing…',
  connectUndone: 'Undone. Your files are as they were.',
  connectFailed: 'That did not work. Nothing was left half done.',
  connectBackups: 'A copy of each file is kept, so Undo puts it back.',

  // 3. Project
  projectTitle: 'Your first project',
  projectLead: 'Pick the folder of one project. The demo only reads it.',
  recent: 'Recent',
  noRecent: 'No projects yet. Choose a folder to start.',
  chooseFolder: 'Choose folder…',
  checking: 'Checking the folder…',
  tooBroad: 'That folder holds too much. Pick the folder of one project instead.',
  tooBig: 'This folder is too big to copy. Pick a smaller one.',
  missing: 'Potato Workspace cannot find that folder. Pick another one.',
  failedFolder: 'That folder did not work. Pick another one.',
  needsGitTitle: 'This folder does not use Git yet.',
  needsGitBody: 'The demo and Undo both need it. Nothing is uploaded.',
  setUpGit: 'Set up Git here',
  gitWorking: 'Setting up Git…',
  gitFiles: (n: number) => `Saves ${n} ${n === 1 ? 'file' : 'files'} as the first snapshot.`,
  gitTooBig: 'This folder has too many files to save as one snapshot. Pick the project folder.',
  projectChosen: 'Ready for the demo.',
  remove: 'Remove',

  // 4. Try it
  taskTitle: 'Try it',
  taskLead: 'One click. Your agent asks another agent for help, and you watch it happen.',
  taskWhat: 'What will happen',
  taskSummary: (agent: string, other: string | null) =>
    other
      ? `${agent} will ask ${other} to look over your latest work. Nothing is changed.`
      : `${agent} will read your project and say what it does. Nothing is changed.`,
  taskExact: 'See the exact words',
  taskStart: (agent: string) => `Open ${agent} and send`,
  taskStarting: 'Opening…',
  taskOpening: (agent: string) => `Opening ${agent}. This can take a few seconds.`,
  taskPaneFailed: 'The agent did not open. Try again, or skip.',
  taskWorking: (agent: string) => `${agent} is working`,
  taskHelpers: 'Agents it started',
  taskNoHelper: 'No other agent yet. If an agent asks you something, answer it below.',
  taskHelperWorking: 'working',
  taskHelperDone: 'done',
  taskHelperNeeds: 'needs you',
  taskHelperFailed: 'failed',
  taskDoneTitle: 'It worked',
  taskDoneBody: 'The second agent sits under the first in the sidebar. Open either to read the full answer.',
  taskTime: (secs: number) => `Your first result took ${secs < 60 ? `${secs} seconds` : `${Math.floor(secs / 60)} min ${secs % 60} s`}.`,
  taskAlone: 'Claude answered by itself, without another agent.',
  taskAloneBody: 'No second agent opened, so this was not the demo.',
  taskAgain: 'Try again',
  taskNoMcp: (agent: string) => `${agent} cannot reach Potato Workspace from here, so the demo did not run.`,
  taskNoMcpHow: 'Go back to Connect your agents and add it again, then restart the agent.',
  taskNoMcpDev: 'In a dev build the agent may be connected to the installed app instead.',
  taskNeedsAgent: 'A demo needs an agent that is ready. Go back to Your agents.',
  taskNeedsProject: 'A demo needs a project. Go back to Your first project.',
  taskAsking: (agent: string) => `${agent} is asking first. You decide.`,
  approvalTip: 'This is an approval card. Nothing risky runs until you choose.',
  openPane: 'Open it',
  taskWarm: 'Started warm: the agent was already waiting.',
  taskCold: 'Starting cold: no warm agent was waiting in this folder.',
  taskSolo: 'Only one agent is ready, so this is a single-agent demo. Add a second agent later to see them work together.',

  // More you can set up
  moreTitle: 'More you can set up',
  morePhone: 'Use your phone',
  morePhoneBody: 'Watch your agents and answer them from your phone.',
  morePack: 'Add skills to your agents',
  morePackBody: 'Teach your agents to hand work to each other. You review every file first.',
  morePackDone: 'Already added in step 2.',
  moreOpen: 'Set up',
  moreBack: 'Back',

  // Phone
  phoneTitle: 'Use your phone',
  phoneLead: 'Watch your agents and answer them from your phone.',
  phoneNote: 'Scan the code with your phone camera. You choose what the phone may do.',

  // Pack
  packTitle: 'Add Potato Workspace to your agents',
  packLead: 'Teach your agents to hand work to each other. You review every file first.',
  packFound: (names: string[]) => (names.length ? `Found: ${names.join(', ')}.` : 'No agent found yet.'),
  packReview: 'Review and install',
  looking: 'Looking for your agents…',

  // Done
  doneTitle: 'You are set',
  doneLead: 'Three things worth knowing.',
  doneLookTitle: 'How do you work?',
  tipKeys: formatKey('Mod+K', isMacPlatform()),
  tipKeysBody: 'Find any agent or action from the keyboard.',
  tipInbox: 'Inbox',
  tipInboxBody: 'Agents that need you wait here. Answer, and they carry on.',
  tipHistory: 'History',
  tipHistoryBody: 'Every turn is saved. Undo this turn puts your files back.',
  doneButton: 'Start using Potato Workspace',
  stepNames: {
    agents: 'Your agents',
    connect: 'Connect your agents',
    project: 'Your first project',
    task: 'Try it',
    done: 'Done',
  } satisfies Record<StepId, string>,

  // Palette and Settings
  paletteTitle: 'Welcome tour',
  paletteDesc: 'Find your agents, connect them, pick a project and try a demo',
  settingLabel: 'Welcome',
  settingHint: 'Go through the first-run welcome again. It never changes your settings unless you choose.',
  settingButton: 'Show the welcome',
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
