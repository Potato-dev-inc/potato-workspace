// zh-TW wording for ../en/dnd.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const dnd: Partial<Record<EnglishKey, string>> = {
  'dnd.dragLive': '正在拖曳「{name}」。移到清單上放開即可放下，按 Esc 取消。',
  'dnd.tabMoveTip': '拖曳可重新排序，或按 Alt+左 / Alt+右',
  'dnd.moved': '已將「{name}」移到第 {n} 個，共 {total} 個',
  'dnd.pinHere': '放到這裡即可釘選',
  'dnd.dropFolder': '放開資料夾即可加為專案',
  'dnd.addProjectTitle': '要加為專案嗎？',
  'dnd.addProjectBody': '要把「{name}」加到你的專案嗎？',
  'dnd.addProjectYes': '加為專案',
  'dnd.notNow': '先不要',
};
