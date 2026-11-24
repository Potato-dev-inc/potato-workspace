// zh-TW wording for ../en/noReply.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const noReply: Partial<Record<EnglishKey, string>> = {
  'chat.noAnswer': '還沒有回應',
  'chat.noAnswer.retry': '再試一次',
  'chat.noAnswer.fresh': '重新開始',
  'chat.sendingStopped': '傳送已停止',
  'chat.composer.placeholder': '寫一則訊息給 AI 助理',
  'chat.summaryNote': '摘要：你的訊息、最終回答與活動紀錄。',
  'chat.status.working': '處理中…',
  'chat.status.stopping': '正在停止…',
  'chat.status.waitingAnswer': '等你回答',
  'chat.agentAnswering.label': '讓 AI 助理回答這些問題',
  'chat.agentAnswering.off': '關閉：只有你能回答。',
  'chat.agentAnswering.on': '開啟：啟動此聊天的 AI 助理可以回答它的權限問題。',
  'chat.waking': '正在喚醒…',
  'phone.st.waking': '正在喚醒…',
};
