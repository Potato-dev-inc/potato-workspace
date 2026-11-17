// Traditional Chinese (Taiwan) for ../en/crewChip.ts (same keys). 分支對話 = spin-off, 小代理 = minion.
import type { EnglishKey } from '../en';

export const crewChip: Partial<Record<EnglishKey, string>> = {
  'crew.aria': '這個對話啟動的 AI 助理',
  'crew.kind.spinOff': '分支對話',
  'crew.kind.minion': '小代理',
  'crew.state.working': '執行中',
  'crew.state.needsYou': '需要你',
  'crew.state.done': '已完成',
  'crew.state.failed': '失敗',
  'crew.chip.one': '{kind}：{title} · {state}',
  'crew.n.spinOffs_one': '{count} 個分支對話',
  'crew.n.spinOffs_other': '{count} 個分支對話',
  'crew.n.minions_one': '{count} 個小代理',
  'crew.n.minions_other': '{count} 個小代理',
  'crew.n.needYou_one': '{count} 個需要你',
  'crew.n.needYou_other': '{count} 個需要你',
  'crew.n.working': '{count} 個執行中',
  'crew.n.done': '{count} 個已完成',
  'crew.n.failed': '{count} 個失敗',
  'crew.group.spinOffs': '分支對話（{n}）',
  'crew.group.minions': '小代理（{n}）',
  'crew.showDone': '{n} 個已完成 · 展開',
  'crew.hideDone': '收起已完成的',
  'crew.open': '開啟 {title}',
  'crew.peek': '查看 {title}。你可以閱讀內容，也可以停止它。',
  'crew.stop': '停止 {title}',
};
