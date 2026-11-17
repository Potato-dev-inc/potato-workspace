// zh-TW wording for ../en/chatMore.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const chatMore: Partial<Record<EnglishKey, string>> = {
  'imageViewer.close': '關閉',
  'imageViewer.prev': '上一張圖片',
  'imageViewer.next': '下一張圖片',
  'imageViewer.count': '第 {n} 張，共 {total} 張',
  'imageViewer.loading': '正在載入圖片…',
  'chat.picture.alt': '圖片',
  'chat.picture.loading': '正在載入圖片…',
  'chat.picture.refused': '沒有顯示圖片。{reason}',
  'chat.picture.enlarge': '放大 {name}',
  'chat.earlier.show': '顯示更早的訊息',
  'chat.earlier.loading': '正在載入更早的訊息…',
  'chat.earlier.failed': '無法載入更早的訊息。',
  'chat.signin.step1': '你的瀏覽器會打開。',
  'chat.signin.step2': '完成後回到這裡。',
  'chat.signin.start': '登入',
  'chat.signin.starting': '正在啟動…',
  'chat.signin.working': '等你完成。完成後會自動重新送出你的訊息。',
  'chat.signin.asking': '登入過程有問題要問你，請在「詳細資料」裡回答。',
  'chat.signin.closed': '登入視窗在完成前就關閉了。',
  'chat.signin.details': '詳細資料',
};
