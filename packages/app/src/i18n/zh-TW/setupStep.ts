// Traditional Chinese (Taiwan) for ../en/setupStep.ts (same keys).
import type { EnglishKey } from '../en';

export const setupStep: Partial<Record<EnglishKey, string>> = {
  'setupStep.status.waiting': '等待中',
  'setupStep.status.running': '進行中…',
  'setupStep.status.retrying': '已試 {n} 次，再試一次…',
  'setupStep.status.done': '完成',
  'setupStep.status.failed': '試了 3 次',
  'setupStep.failedSentence': '{step} 沒有成功。',
  'setupStep.failedStep': '這個步驟',
  'setupStep.tried': '試了 {n} 次。沒有留下做到一半的東西。',
  'setupStep.fix': '讓 Claude 幫我修好',
  'setupStep.fixAgent': '讓 {agent} 幫我修好',
  'setupStep.fixing': '正在開啟聊天…',
  'setupStep.retry': '再試一次',
  'setupStep.details': '詳細資料',
};
