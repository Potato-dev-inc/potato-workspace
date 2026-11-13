// zh-TW wording for ../en/companion.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const companion: Partial<Record<EnglishKey, string>> = {
  'companion.mood.stopped': '已停止',
  'companion.mood.starting': '正在醒來',
  'companion.mood.needsYou': '需要你',
  'companion.mood.oneNeedsYou': '{name} 需要你',
  'companion.mood.manyNeedYou_other': '{count} 位 AI 助理需要你',
  'companion.mood.done': '都完成了',
  'companion.mood.watching_other': '正在看著 {count} 位 AI 助理',
  'companion.mood.working': '工作中',
  'companion.mood.sleepy': '想睡了',
  'companion.mood.sleepyNotes_other': '想睡了 · 有 {count} 則備忘給你',
  'companion.mood.here': '在這裡',
  'companion.row.label': '{name}，{line}',
  'companion.make': '建立夥伴',
  'companion.makeQuiet': '想要一位夥伴嗎？建立一位',
  'companion.makeDismiss': '先隱藏',
};
