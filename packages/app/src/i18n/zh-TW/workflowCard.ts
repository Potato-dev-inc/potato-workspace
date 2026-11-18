// Traditional Chinese (Taiwan) for ../en/workflowCard.ts (same keys). 「工作流程」 matches ./workflows.ts.
import type { EnglishKey } from '../en';

export const workflowCard: Partial<Record<EnglishKey, string>> = {
  'workflowCard.using': '使用工作流程：{name}',
  'workflowCard.show': '看它收到的指示',
  'workflowCard.hide': '收起',
};

// 「標記」: a mark-up sent from the agent browser (the bar in the browser uses 標記 too).
export const markupCard: Partial<Record<EnglishKey, string>> = {
  'markupCard.label': '標記了：{page}',
  'markupCard.one': '1 個標記',
  'markupCard.many': '{n} 個標記',
  'markupCard.thisPage': '一個頁面',
  'markupCard.show': '看 AI 助理收到的內容',
};
