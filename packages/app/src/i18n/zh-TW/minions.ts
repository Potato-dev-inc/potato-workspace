// Traditional Chinese (Taiwan) for ../en/minions.ts (same keys). 小代理 = minion, 分支對話 = spin-off (see ./twoTypes.ts).
import type { EnglishKey } from '../en';

export const minions: Partial<Record<EnglishKey, string>> = {
  'minion.row.working': '小代理執行中',
  'minion.row.minion': '小代理',
  'minion.row.named': '小代理：{description}',
  'minion.row.see': '查看 {title}',
  'minion.row.status': '{kind}（{status}）',
  'minion.row.titled': '{kind}：{title}',
  'minion.row.startedAgent': '啟動的 AI 助理',
  'minion.activity.started_one': '啟動了 {count} 個 AI 助理',
  'minion.activity.started_other': '啟動了 {count} 個 AI 助理',
  'minion.budget.label': '啟動的 AI 助理',
  'side.noAgent': '還沒有設定用來回答側邊問題的 AI 助理。請到 AI 助理設定。',
  'side.reads': '另一個 AI 助理會讀取最近的對話並在這裡回答。你的 AI 助理看不到這些內容。',
  'crew.leftOut_one': '還有 {count} 個 AI 助理沒有放進來。一個團隊最多容納 8 個 AI 助理。',
  'crew.leftOut_other': '還有 {count} 個 AI 助理沒有放進來。一個團隊最多容納 8 個 AI 助理。',
  'live.andIts_one': '和它的 {count} 個 AI 助理',
  'live.andIts_other': '和它的 {count} 個 AI 助理',
  'companion.newDesc': '一直開著的助理，在你的 AI 助理上執行',
  'companion.setup.lead': '你自己的助理，一直開著。它在你的 AI 助理和方案上執行。',
};
