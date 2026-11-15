// zh-TW wording for ../en/companions.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const companions: Partial<Record<EnglishKey, string>> = {
  'companions.new': '新增夥伴',
  'companions.newLimit': '你已經有 {max} 位夥伴了。先封存一位，才能再建立。',
  'companions.default': '預設',
  'companions.defaultTitle': '{name} 是預設夥伴。提示氣泡、桌面小夥伴和手機會優先用它。',
  'companions.makeDefault': '設為預設',
  'companions.makeDefaultDone': '{name} 現在是預設夥伴。',
  'companions.makeDefaultFailed': '無法更改預設夥伴。',
  'companions.switch': '切換夥伴',
  'companions.goTo': '前往夥伴：{name}',
  'companions.setup.another': '建立另一位夥伴',
  'companions.setup.colour': '顏色',
  'companions.setup.startFrom': '從哪裡開始',
  'companions.setup.startEmpty': '全新的',
  'companions.setup.startCopy': '複製 {name} 的說話方式',
  'companions.setup.startCopyHint': '只會複製「它是誰」這段文字。備忘和記憶仍留在 {name} 那裡。',
  'companions.setup.copyFailed': '已建立，但無法複製 {name} 的說話方式。',
  'companions.accent.potato': '馬鈴薯',
  'companions.accent.sky': '天藍',
  'companions.accent.mint': '薄荷',
  'companions.accent.rose': '玫瑰',
  'companions.accent.sun': '陽光',
  'companions.awakeNote': '同一時間最多有三位夥伴醒著，其他的會睡著，等你叫醒。',
  'pet.companion.resting': '{name}，休息中',
};
