// zh-TW wording for ../en/board.ts (same keys). Agent = AI 助理; the board is a 看板.
import type { EnglishKey } from '../en';

export const board: Partial<Record<EnglishKey, string>> = {
  'board.title': 'AI 助理看板',
  'board.sub': '所有 AI 助理放在同一個畫面，點一下就能打開。',
  'board.close': '關閉看板',
  'board.col.needs': '需要你',
  'board.col.working': '工作中',
  'board.col.done': '已完成',
  'board.empty.needs': '目前沒有人在等你。',
  'board.empty.working': '目前沒有 AI 助理在工作。',
  'board.empty.done': '還沒有完成的工作。',
  'board.answerGroup': '快速回答',
  'board.age.now': '剛剛',
  'board.age.minutes': '已 {count} 分鐘',
  'board.age.hours': '已 {count} 小時',
  'settings.row.shortcut-agent-board.label': 'AI 助理看板：三欄列出所有 AI 助理',
};
