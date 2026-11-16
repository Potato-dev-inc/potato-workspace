// zh-TW wording for ../en/sentFrom.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const sentFrom: Partial<Record<EnglishKey, string>> = {
  'sentFrom.from': '來自 {name}',
  'sentFrom.app': '來自 Potato Workspace：AI 助理已完成',
  'drive.typing': '{name} 正在輸入…',
  'drive.driving': '{name} 正在操作',
  'drive.takeBack': '拿回來',
  'drive.takingBack': '正在拿回來…',
  'drive.tookBack': '{name} 已拿回這個對話',
  'drive.takeOver': '接手',
  'drive.takeOverFailed': '無法接手，請再試一次。',
  'drive.takeBackFailed': '無法拿回來，請再試一次。',
  'devices.rename': '重新命名',
  'devices.renameLabel': '{name} 的名稱',
  'devices.renameSave': '儲存',
  'devices.renameCancel': '取消',
  'devices.renameHint': '這個名稱會顯示在這台裝置所傳訊息的下方。',
  'devices.renameFailed': '無法重新命名，請再試一次。',
};
