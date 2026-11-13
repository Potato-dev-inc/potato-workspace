// zh-TW wording for ../en/notify.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const notify: Partial<Record<EnglishKey, string>> = {
  'notify.level.everything': '全部通知',
  'notify.level.needs': '只在需要我時',
  'notify.level.finished': '只在完成時',
  'notify.level.silent': '靜音',
  'notify.bell.option': '通知：{level}',
  'notify.bell.optionNow': '通知：{level}（目前）',
  'notify.bell.tip': '這個 AI 助理可以打擾你到什麼程度。高風險的確認一定會通知你。',
  'notify.quiet.label': '勿擾時段',
  'notify.quiet.hint': '夜間不通知，電腦和手機都一樣。高風險的確認仍會通知你。',
  'notify.quiet.on': '勿擾時段',
  'notify.quiet.from': '從',
  'notify.quiet.to': '到',
  'notify.quiet.fromAria': '勿擾時段開始時間',
  'notify.quiet.toAria': '勿擾時段結束時間',
  'notify.agent.label': '通知',
  'notify.agent.hint': '{agent} 可以打擾你到什麼程度。高風險的確認一定會通知你。',
  'notify.agent.aria': '{agent} 的通知',
  'notify.agent.helperLabel': '它的幫手的通知',
  'notify.agent.helperHint': '{agent} 啟動的幫手預設比較安靜：只在需要你時通知。',
  'notify.agent.helperAria': '{agent} 的幫手的通知',
  'notify.snooze': '暫停 30 分鐘',
  'notify.snoozed': '已暫停 30 分鐘',
  'notify.snooze.tip': '這張卡片 30 分鐘內不再通知。它仍留在收件匣。',
};
