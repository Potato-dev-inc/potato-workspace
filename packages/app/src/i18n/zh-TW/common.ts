// zh-TW wording for ../en/common.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const common: Partial<Record<EnglishKey, string>> = {
  'common.open': '開啟',
  'common.dismiss': '關閉',
  'common.undo': '復原',
  'common.reopen': '重新開啟',
  'common.tryAgain': '再試一次',
  'common.copyDetails': '複製詳細資訊',
  'common.copied': '已複製',
  'common.otherWays': '其他方式',
  'common.errorTitle': '這裡出了點問題',
  'common.errorBody': 'App 的其他部分都正常。請再試一次；如果一直發生，請複製詳細資訊傳給我們。',
  'common.err.generic': '出了點問題，請再試一次。',
  'common.err.trustDeclined': '你選擇不信任這個資料夾，所以沒有送出任何內容。',
  'common.err.agentExited': 'AI 助理意外關閉了。你的檔案停在它離開時的狀態。',
  'common.err.notInstalled': '這台電腦還沒安裝這個 AI 助理。',
  'common.err.secureStoreFull': 'Windows 存放金鑰的地方已經沒有空間，所以沒有儲存任何東西。請在 Windows 認證管理員中騰出一些空間，再試一次。',
  'common.err.secureStore': 'Windows 沒有開啟存放金鑰的地方，所以沒有儲存任何東西。請稍後再試一次。',
  'common.err.relayDown': '連不上 {host} 的中繼站。請檢查位址和網路，再試一次。',
  'common.err.notReady': 'AI 助理還沒準備好，所以沒有輸入任何內容。',
  'common.err.promptNotSubmitted': '任務已經輸入，但 AI 助理沒有開始處理。',
};
