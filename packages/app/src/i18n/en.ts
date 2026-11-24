// English: the source of truth. Every message lives in a group file under ./en; zh-TW.ts mirrors the same keys.
// Plural messages are written as `<key>_one` and `<key>_other` and called as t('<key>', { count }).
import { common } from './en/common';
import { timeline } from './en/timeline';
import { connect } from './en/connect';
import { sidebar } from './en/sidebar';
import { whatsnew } from './en/whatsnew';
import { inbox } from './en/inbox';
import { status } from './en/status';
import { newAgent } from './en/newAgent';
import { pane } from './en/pane';
import { addAgent } from './en/addAgent';
import { settings } from './en/settings';
import { firstRun } from './en/firstRun';
import { inboxCards } from './en/inboxCards';
import { lookFeel } from './en/lookFeel';
import { risk } from './en/risk';
import { state } from './en/state';
import { overview } from './en/overview';
import { team } from './en/team';
import { companion } from './en/companion';
import { companions } from './en/companions';
import { settingsRows } from './en/settingsRows';
import { settingsPreviews } from './en/settingsPreviews';
import { settingsLane } from './en/settingsLane';
import { settingsIntake } from './en/settingsIntake';
import { settingsShortcuts } from './en/settingsShortcuts';
import { settingsGeneral } from './en/settingsGeneral';
import { settingsModelBridge } from './en/settingsModelBridge';
import { settingsMisc } from './en/settingsMisc';
import { settingsBridge } from './en/settingsBridge';
import { settingsToolbelt } from './en/settingsToolbelt';
import { settingsKeys } from './en/settingsKeys';
import { settingsPack } from './en/settingsPack';
import { settingsAgentPage } from './en/settingsAgentPage';
import { settingsPreload } from './en/settingsPreload';
import { standbyHelpers } from './en/standbyHelpers';
import { settingsAgents } from './en/settingsAgents';
import { settingsTelegram } from './en/settingsTelegram';
import { settingsLend } from './en/settingsLend';
import { settingsTeam } from './en/settingsTeam';
import { settingsConnect } from './en/settingsConnect';
import { settingsPhone } from './en/settingsPhone';
import { workerUpdate } from './en/workerUpdate';
import { setupStep } from './en/setupStep';
import { notify } from './en/notify';
import { board } from './en/board';
import { routines } from './en/routines';
import { teamPage } from './en/teamPage';
import { phone } from './en/phone';
import { phoneChat } from './en/phoneChat';
import { noReply } from './en/noReply';
import { desk } from './en/desk';
import { sentFrom } from './en/sentFrom';
import { projectBudget } from './en/projectBudget';
import { dnd } from './en/dnd';
import { files } from './en/files';
import { artifacts } from './en/artifacts';
import { guide } from './en/guide';
import { pet } from './en/pet';
import { minions } from './en/minions';
import { taskDrag } from './en/taskDrag';
import { crewChip } from './en/crewChip';
import { r15misc } from './en/r15misc';
import { r21 } from './en/r21';
import { phoneCompose } from './en/phoneCompose';
import { phoneShell } from './en/phoneShell';
import { phoneHalf } from './en/phoneHalf';
import { chatUx } from './en/chatUx';
import { chatMore } from './en/chatMore';
import { r9 } from './en/r9';
import { r10 } from './en/r10';
import { r12ui } from './en/r12ui';
import { r13ui } from './en/r13ui';
import { r14review } from './en/r14review';
import { r14ui } from './en/r14ui';
import { r15far } from './en/r15far';
import { r21fn } from './en/r21fn';
import { r23ui } from './en/r23ui';
import { r11ui } from './en/r11ui';
import { point } from './en/point';
import { markup } from './en/markup';
import { check } from './en/check';
import { flow } from './en/flow';
import { appUx } from './en/appUx';
import { deskReview } from './en/deskReview';
import { devices } from './en/devices';
import { myAgents } from './en/myAgents';
import { crews } from './en/crews';
import { workflows } from './en/workflows';
import { workflowCard, markupCard } from './en/workflowCard';
import { crewCanvas } from './en/crewCanvas';
import { crewTalk } from './en/crewTalk';
import { account } from './en/account';
import { agentRules } from './en/agentRules';
import { rail } from './en/rail';

export const en = {
  ...common,
  ...sidebar,
  ...inbox,
  ...whatsnew,
  ...status,
  ...newAgent,
  ...pane,
  ...addAgent,
  ...settings,
  ...firstRun,
  ...inboxCards,
  ...lookFeel,
  ...risk,
  ...state,
  ...overview,
  ...team,
  ...companion,
  ...companions,
  ...settingsRows,
  ...settingsPreviews,
  ...settingsLane,
  ...settingsIntake,
  ...settingsShortcuts,
  ...settingsGeneral,
  ...settingsModelBridge,
  ...settingsMisc,
  ...settingsBridge,
  ...settingsToolbelt,
  ...settingsKeys,
  ...settingsPack,
  ...settingsAgentPage,
  ...settingsPreload,
  ...standbyHelpers,
  ...settingsAgents,
  ...settingsTelegram,
  ...settingsLend,
  ...settingsTeam,
  ...settingsConnect,
  ...settingsPhone,
  ...workerUpdate,
  ...setupStep,
  ...notify,
  ...board,
  ...routines,
  ...teamPage,
  ...phone,
  ...phoneChat,
  ...noReply,
  ...desk,
  ...sentFrom,
  ...projectBudget,
  ...dnd,
  ...files,
  ...artifacts,
  ...guide,
  ...pet,
  ...phoneCompose,
  ...phoneShell,
  ...phoneHalf,
  ...chatUx,
  ...chatMore,
  ...r9,
  ...r10,
  ...r12ui,
  ...r13ui,
  ...r14review,
  ...r14ui,
  ...r15far,
  ...r21fn,
  ...r23ui,
  ...r11ui,
  ...flow,
  ...point,
  ...markup,
  ...check,
  ...appUx,
  ...deskReview,
  ...devices,
  ...myAgents,
  ...crews,
  ...crewCanvas,
  ...workflows,
  ...workflowCard,
  ...markupCard,
  ...crewTalk,
  ...account,
  ...agentRules,
  ...rail,
  ...timeline,
  ...connect,
  ...minions,
  ...taskDrag,
  ...crewChip,
  ...r15misc,
  ...r21,
} as const;

export type MessageKey = Exclude<keyof typeof en, `${string}_one` | `${string}_other`> | PluralKey;
export type PluralKey = keyof typeof en extends infer K ? (K extends `${infer B}_other` ? B : never) : never;
export type EnglishKey = keyof typeof en;
