// zh-TW wording for ../en/status.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const status: Partial<Record<EnglishKey, string>> = {
  'status.usage': '使用量',
  'status.planUsage': '方案使用量',
  'status.refreshUsage': '重新整理使用量',
  'status.clickForDetails': '點一下看詳細資訊',
  'status.notShared': '這個 AI 助理不提供使用量',
  'status.today': '今天',
  'status.last7Days': '過去 7 天',
  'status.costTokens': '{cost} · {tokens} token',
  'status.resetsIn': '{time}後重設',
  'status.startedAgain': '已重新計算',
  'status.percentUsed': '已使用 {pct}%',
  'status.windowUsed': '{name} 已使用',
  'status.readAgo': '{time}前讀取',
  'status.usagePage': '使用量頁面',
  'status.moreUsage': '還有 {n} 項：開啟使用量',
  'status.working': '{n} 個工作中',
  'status.needsYou_one': '{count} 個需要你',
  'status.needsYou_other': '{count} 個需要你',
};
