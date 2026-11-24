// zh-TW wording for ../en/check.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const check: Partial<Record<EnglishKey, string>> = {
  'check.openBrowser': '開啟瀏覽器',
  'check.openBrowserTip': '開啟瀏覽器視窗，自己查看網頁。需要時可以請 AI 助理加入。',
  'check.openBrowserFailed': '瀏覽器沒有開啟。',
  'check.chip': '檢查',
  'check.chipTip': '在 AI 助理瀏覽器開啟應用程式，找出錯誤並拍一張圖',
  'check.label': '在瀏覽器檢查',
  'check.running': '正在檢查頁面…',
  'check.pass': '看起來沒問題',
  'check.fail': '發現問題',
  'check.signIn': '需要你登入',
  'check.error': '無法檢查',
  'check.again': '再檢查一次',
  'check.close': '關閉',
  'check.passHelp': '頁面已載入，沒有出現錯誤。',
  'check.notLoaded': '頁面沒有載入完成。開發伺服器有在執行嗎？',
  'check.signInHelp': '頁面要求登入。請在瀏覽器視窗登入，按「繼續」，再檢查一次。',
  'check.problems': '頁面回報了 {n} 個問題',
  'check.more': '還有 {n} 個',
  'check.shotAlt': '頁面的圖片',
  'check.enlarge': '放大圖片',
  'check.fix': '請 AI 助理修正',
  'check.fixLead': '頁面出現問題，請修正。以下是從頁面複製的內容：',
  'check.sent': '已傳給 AI 助理。',
  'check.failed': '檢查沒有成功。',
};
