// zh-TW wording for ../en/flow.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const flow: Partial<Record<EnglishKey, string>> = {
  // Update ready while agents work, and "What is new" after the restart.
  'flow.update.groupLabel': '更新已準備好',
  'flow.update.ready': '更新已準備好。',
  'flow.update.readyVersion': '更新已準備好 · {version}。',
  'flow.update.working_one': '有 1 個 AI 助理正在工作。',
  'flow.update.working_other': '有 {count} 個 AI 助理正在工作。',
  'flow.update.notStopped': '不會被中斷。',
  'flow.update.whenFinish': '等它們完成後',
  'flow.update.tonight': '今晚',
  'flow.update.now': '現在',
  'flow.update.waitingFinish': '它們完成後會自動安裝。重新啟動後，你的對話會回來。',
  'flow.update.waitingTonight': '會在 {time} 安裝，前提是它們已經完成。重新啟動後，你的對話會回來。',
  'flow.whatsNew.title': '{version} 有什麼新功能',
  'flow.whatsNew.chatsBack_one': '你的對話已經回來了。',
  'flow.whatsNew.chatsBack_other': '你的 {count} 個對話已經回來了。',
  'flow.whatsNew.close': '知道了',

  // Sign-in fix card.
  'flow.signin.title': '{agent} 的登入已失效。',
  'flow.signin.kept': '你的訊息已保留。',
  'flow.signin.sent': '已重新送出。',
  'flow.signin.again': '重新登入',
  'flow.signin.openAgain': '再開啟一次登入',
  'flow.signin.waiting': '請完成登入，之後會自動重新送出你的訊息。',
  'flow.signin.gaveUp': '還在等待登入。',
  'flow.signin.sendNow': '現在送出',
  'flow.signin.stillOut': '{agent} 的登入還沒有恢復。',
  'flow.signin.useOther': '改用 {agent} 處理',

  // Problems list.
  'flow.problems.title': '問題',
  'flow.problems.count_one': '1 個問題',
  'flow.problems.count_other': '{count} 個問題',
  'flow.problems.none': '沒有出錯。',
  'flow.problems.clear': '清除',
  'flow.problems.fixed': '已解決',
  'flow.problems.notFixed': '尚未解決',
  'flow.problems.openChat': '開啟對話',
  'flow.problems.signIn': '登入',
  'flow.problems.tryAgain': '再試一次',
  'flow.problems.copy': '複製詳細資訊',
  'flow.problems.stopped': '{agent} 因為錯誤而停止。',
  'flow.problems.stuck': '{agent} 似乎卡住了。',
  'flow.problems.signedOut': '{agent} 的登入已失效。',

  // The shared error card.
  'flow.error.whatHappened': '發生了什麼事',
  'flow.error.whatToDo': '你可以怎麼做',
  'flow.error.showDetails': '顯示詳細資訊',
  'flow.error.hideDetails': '隱藏詳細資訊',
  'flow.error.copy': '複製給客服',
  'flow.error.copied': '已複製',
  'flow.error.chatStopped.can': '重新啟動對話。你的內容都還在。',
  'flow.error.chatStopped.restart': '重新啟動對話',
  'flow.error.chatStopped.restarting': '重新啟動中…',
  'flow.error.chatStopped.retry': '重試',
  'flow.error.updateFailed.can': '目前的版本仍可正常使用。請稍後再試一次。',

  // Quiet start-up check.
  'flow.startup.bridge': '應用程式與 AI 助理之間的連線中斷了。',
  'flow.startup.checkSetup': '檢查我的設定',
  'flow.startup.disk': '你的磁碟快滿了（剩下 {gb} GB）。AI 助理可能無法儲存工作成果。',
  'flow.startup.update': '無法連到更新位址，更新會先等一等。',
  'flow.startup.terminals': '你的 AI 助理只能在終端機中執行，而終端機目前是隱藏的。',
  'flow.startup.showTerminals': '顯示終端機',
  'flow.startup.more': '（還有 {count} 項）',
  'flow.startup.dismiss': '關閉',
};
