// The files whose visible text has moved to translation keys. The guard test (guard.test.ts) scans exactly these:
// a new hard-coded English string in one of them fails the test. Add a file here when you move its strings.
// Paths are relative to packages/app/src.
const C = 'components/cockpit/';
export const MOVED_FILES: readonly string[] = [
  // sidebar, footer, project cards, usage bar
  `${C}Sidebar.tsx`, `${C}SidebarFooter.tsx`, `${C}ProjectHeader.tsx`, `${C}RowMark.tsx`, `${C}UsageBar.tsx`, `${C}PaneContextMenu.tsx`,
  // inbox, empty states, undo, toasts
  `${C}Inbox.tsx`, `${C}InboxCard.tsx`, `${C}InboxError.tsx`, `${C}NoChatPrompt.tsx`, `${C}UndoSheet.tsx`, `${C}EndedAgentsLine.tsx`,
  'components/common/EmptyState.tsx', 'components/common/ErrorBoundary.tsx', 'components/settings/UndoToast.tsx',
  // inbox cards
  `${C}QuestionCard.tsx`, `${C}StuckCard.tsx`, `${C}PaneApprovalCard.tsx`, `${C}ApprovalPrompt.tsx`, `${C}ConsentCard.tsx`, `${C}LimitCard.tsx`,
  `${C}BudgetCard.tsx`, `${C}IssueCard.tsx`, `${C}CiFixCard.tsx`, `${C}AskNotices.tsx`, `${C}HiddenRuns.tsx`, `${C}ImportChatsCard.tsx`,
  `${C}CanaryNotices.tsx`,
  // new agent page, pane header and tabs
  `${C}newagent/NewAgentPage.tsx`, `${C}newagent/HomeCards.tsx`, `${C}newagent/Starters.tsx`, `${C}newagent/HiddenAgentsEditor.tsx`,
  `${C}NewAgentMenu.tsx`, `${C}PaneView.tsx`, `${C}PaneTabs.tsx`, `${C}PaneMoreMenu.tsx`, `${C}RenameTitle.tsx`,
  // Add an agent box, first run
  'components/settings/blocks/AddAgent.tsx', 'components/settings/blocks/AddAgentAdvanced.tsx', 'components/settings/blocks/AddAgentFound.tsx',
  'components/settings/blocks/AddAgentParts.tsx', `${C}AddAgentActionHost.tsx`,
  'components/firstrun/FirstRun.tsx', 'components/firstrun/StepAgents.tsx', 'components/firstrun/StepConnect.tsx', 'components/firstrun/StepProject.tsx',
  'components/firstrun/StepTask.tsx', 'components/firstrun/StepsSmall.tsx',
  // settings shell and Look and feel
  'components/SettingsPanel.tsx', `${C}SettingsView.tsx`, 'components/settings/SectionView.tsx', 'components/settings/Overview.tsx',
  'components/settings/SettingsDamagedBanner.tsx', 'components/settings/settings-ui.tsx', 'components/settings/row-meta.tsx',
  'components/settings/blocks/StartAtSignInSettings.tsx', 'components/settings/previews/Thumbs.tsx', 'components/settings/previews/Previews.tsx',
  'components/settings/sections/LanguageRow.tsx',
  // round 2: the pieces those screens still showed in English
  `${C}DotSpinner.tsx`, `${C}RestoreSheet.tsx`, `${C}rail/JobsChip.tsx`, `${C}rail/BackgroundJobs.tsx`, `${C}rail/BackgroundCard.tsx`,
  `${C}night/NightChip.tsx`, 'components/chat/HandedToTerminal.tsx', 'components/common/ModelPicker.tsx', 'components/history/BringChatsLink.tsx',
  'components/settings/SetupCheckPage.tsx', 'components/settings/sections/UpdateRow.tsx', 'components/settings/blocks/WhatsNew.tsx',
  'components/updates/UpdateNotice.tsx',
];
