// zh-TW wording for ../en/risk.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
// Helper and lib texts: approval words, questions, sign-in words, error cards, restore.
import type { EnglishKey } from '../en';

export const risk: Partial<Record<EnglishKey, string>> = {
  'risk.level.low': '低風險',
  'risk.level.medium': '請先確認',
  'risk.level.high': '高風險',
  'risk.caution': '允許之前請先看清楚，之後可能很難復原。',
  'risk.choice.deny': '拒絕',
  'risk.choice.alwaysAllowStarting': '一律允許開頭為以下內容的指令：',
  'risk.choice.alwaysAllow': '一律允許',
  'risk.choice.allowSession': '這次工作階段都允許',
  'risk.choice.allowOnce': '允許一次',

  'risk.ask.anAgent': '某個 AI 助理',
  'risk.ask.theAgent': 'AI 助理',
  'risk.ask.underMinute': '不到 1 分鐘',
  'risk.ask.minutes': '{n} 分鐘',
  'risk.ask.hours': '{n} 小時',
  'risk.ask.stoppedWaiting': '{who} 已停止等待',
  'risk.ask.stopsWaiting': '{who} 會在{time}後停止等待',

  'risk.signIn.action': '登入',
  'risk.signIn.needed': '需要登入',
  'risk.signIn.group': '登入',
  'risk.signIn.rowLabel': '登入',
  'risk.signIn.rowHint': '同一個 AI 助理可以登入多個帳號，每個窗格各選一個使用。',
  'risk.signIn.addAnother': '新增其他帳號',
  'risk.signIn.openWindow': '開啟登入視窗',
  'risk.signIn.useAnother': '改用其他帳號',
  'risk.signIn.noun': '帳號',
  'risk.signIn.defaultOne': '預設帳號',

  'risk.stuck': '{name} 好像卡住了：{summary}。',

  'risk.error.startAgain': '重新開始',
  'risk.error.install': '安裝',
  'risk.error.open': '開啟',
  'risk.error.declined.title': '{agent} 沒有啟動',
  'risk.error.declined.sentence': '你選擇不信任這個資料夾，所以任務沒有送出。重新開始就會再問你一次。',
  'risk.error.exited.title': '{agent} 已停止',
  'risk.error.exited.sentence': '它意外關閉了。你的檔案停在它離開時的狀態。',
  'risk.error.notInstalled.title': '尚未安裝 {agent}',
  'risk.error.notInstalled.sentence': '這台電腦還沒有它，所以沒有執行任何動作。',
  'risk.error.notReady.title': '{agent} 還沒準備好',
  'risk.error.notReady.sentence': '它沒有進入就緒畫面，所以 Potato Workspace 沒有輸入任何內容。',
  'risk.error.notSubmitted.title': '{agent} 沒有開始任務',
  'risk.error.notSubmitted.sentence': '任務已經輸入，但它沒有開始處理。',
  'risk.error.unknown.sentence': '你的檔案停在它離開時的狀態。開啟它看看發生了什麼事。',

  'risk.ended_one': '上次重新啟動時，有 {count} 個終端機 AI 助理結束了。',
  'risk.ended_other': '上次重新啟動時，有 {count} 個終端機 AI 助理結束了。',

  'risk.restore.confirm': '還原檔案',
  'risk.restore.body': '這會還原你的檔案，但不會改變 AI 助理記得的內容。在那之後建立的檔案會被移除，.gitignore 中的檔案則不受影響。',
  'risk.restore.safe': '會先儲存你目前的檔案，所以之後可以從「歷史紀錄」復原。',
  'risk.restore.cancel': '取消',
  'risk.restore.busy': '還原中…',
  'risk.restore.failedFiles': '有 {n} 個檔案無法變更。',
  'risk.restore.done': '已將檔案還原到「{title}」。{failed}',
  'risk.restore.undo': '復原',
  'risk.restore.undone': '已復原。你的檔案回到還原之前的狀態。',
};
