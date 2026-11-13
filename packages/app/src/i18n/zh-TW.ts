// Traditional Chinese (Taiwan). Reviewed wording (Fable review); the messages live in the group files under ./zh-TW.
// Same keys as en.ts; a key left out falls back to English. Product names, file paths and model ids are never translated.
//
// Term choices (keep them the same in every group file):
//   agent     -> AI 助理   Taiwan already says 助理 for this kind of thing (Google 助理, 語音助理, AI 助理), so a person
//                          who does not code understands it at once. 代理程式 is the Microsoft glossary word: correct,
//                          but it reads like a system process, and bare 代理 sounds like a sales agent or a proxy.
//   helper    -> 幫手      an AI 助理 that another AI 助理 started; short, and clearly not the same word as 助理.
//   chat      -> 對話      both the Chat view and "your chats"; 聊天 sounds like small talk, not work.
//   terminal  -> 終端機
//   pane      -> 窗格
//   sign in   -> 登入 (verb, state); a sign-in you can pick or add (the noun) -> 帳號
//   usage     -> 使用量;  plan -> 方案
//   project 專案, branch 分支, Inbox 收件匣, Settings 設定, reset 重設, undo 復原, restore 還原,
//   checkpoint 還原點, snapshot 快照, separate copy 獨立副本, hand off 交接, turn 回合, PC 電腦, tray 系統匣,
//   Night Shift 夜班, Mission 任務計畫, Simple mode 簡易模式, Labs stays Labs.
//   The reader is 你 (not 您). Chinese text uses full-width punctuation, with a space between Chinese and Latin or digits.
import type { EnglishKey } from './en';
import { common } from './zh-TW/common';
import { sidebar } from './zh-TW/sidebar';
import { inbox } from './zh-TW/inbox';
import { status } from './zh-TW/status';
import { newAgent } from './zh-TW/newAgent';
import { pane } from './zh-TW/pane';
import { addAgent } from './zh-TW/addAgent';
import { settings } from './zh-TW/settings';
import { firstRun } from './zh-TW/firstRun';
import { inboxCards } from './zh-TW/inboxCards';
import { lookFeel } from './zh-TW/lookFeel';
import { risk } from './zh-TW/risk';
import { state } from './zh-TW/state';
import { overview } from './zh-TW/overview';
import { team } from './zh-TW/team';
import { companion } from './zh-TW/companion';
import { settingsRows } from './zh-TW/settingsRows';
import { settingsPreviews } from './zh-TW/settingsPreviews';
import { settingsLane } from './zh-TW/settingsLane';
import { settingsIntake } from './zh-TW/settingsIntake';
import { settingsShortcuts } from './zh-TW/settingsShortcuts';
import { settingsGeneral } from './zh-TW/settingsGeneral';
import { settingsModelBridge } from './zh-TW/settingsModelBridge';
import { settingsMisc } from './zh-TW/settingsMisc';
import { settingsBridge } from './zh-TW/settingsBridge';
import { settingsToolbelt } from './zh-TW/settingsToolbelt';
import { settingsKeys } from './zh-TW/settingsKeys';
import { settingsPack } from './zh-TW/settingsPack';
import { settingsAgentPage } from './zh-TW/settingsAgentPage';
import { settingsPreload } from './zh-TW/settingsPreload';
import { settingsAgents } from './zh-TW/settingsAgents';
import { settingsTelegram } from './zh-TW/settingsTelegram';
import { settingsLend } from './zh-TW/settingsLend';
import { settingsTeam } from './zh-TW/settingsTeam';
import { settingsConnect } from './zh-TW/settingsConnect';
import { settingsPhone } from './zh-TW/settingsPhone';
import { notify } from './zh-TW/notify';
import { board } from './zh-TW/board';
import { phone } from './zh-TW/phone';
import { phoneChat } from './zh-TW/phoneChat';
import { dnd } from './zh-TW/dnd';
import { files } from './zh-TW/files';
import { pet } from './zh-TW/pet';
import { phoneCompose } from './zh-TW/phoneCompose';
import { chatUx } from './zh-TW/chatUx';
import { appUx } from './zh-TW/appUx';

export const zhTW: Partial<Record<EnglishKey, string>> = {
  ...common,
  ...sidebar,
  ...inbox,
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
  ...settingsAgents,
  ...settingsTelegram,
  ...settingsLend,
  ...settingsTeam,
  ...settingsConnect,
  ...settingsPhone,
  ...notify,
  ...board,
  ...phone,
  ...phoneChat,
  ...dnd,
  ...files,
  ...pet,
  ...phoneCompose,
  ...chatUx,
  ...appUx,
};
