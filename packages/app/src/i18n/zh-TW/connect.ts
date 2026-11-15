// zh-TW wording for ../en/connect.ts (same keys). Connect = 連結; agent = AI 助理; lend = 出借; borrow = 借用.
import type { EnglishKey } from '../en';

export const connect: Partial<Record<EnglishKey, string>> = {
  'connect.side': '連結',
  'connect.title': '連結',
  'connect.lead': '你的手機、其他電腦、團隊與出借,都在這一頁。',
  'connect.stay': '登入留在各自的裝置上,不會被複製。',
  'connect.tabs.aria': '連結分頁',
  'connect.tab.phone': '手機',
  'connect.tab.pcs': '我的電腦',
  'connect.tab.team': '團隊',
  'connect.tab.lending': '出借',

  'connect.phone.count_one': '已配對 {count} 支手機。',
  'connect.phone.count_other': '已配對 {count} 支手機。',
  'connect.phone.none': '還沒有配對手機。',
  'connect.phone.pair': '配對手機',
  'connect.phone.address': '使用固定網址',
  'connect.phone.moreTitle': '手機通知與登出',

  'connect.pcs.count_one': '已配對 {count} 台其他電腦 · {online} 台在線上。',
  'connect.pcs.count_other': '已配對 {count} 台其他電腦 · {online} 台在線上。',
  'connect.pcs.none': '還沒有配對其他電腦。',
  'connect.pcs.offTitle': '使用多台電腦',
  'connect.pcs.offLine': '配對另一台電腦,就能在那裡執行 AI 助理或終端機,也能在兩台之間搬移對話與檔案。',
  'connect.pcs.turnOn': '開啟我的電腦',

  'connect.team.on_one': '你在一個團隊裡,還有 {count} 位成員。',
  'connect.team.on_other': '你在一個團隊裡,還有 {count} 位成員。',
  'connect.team.alone': '你在一個團隊裡,還沒有其他人加入。',
  'connect.team.none': '你還沒有加入團隊。',

  'connect.lending.status': '出借 {out} · 借用 {in}。',
  'connect.lending.none': '目前沒有出借或借用。',
  'connect.lending.offTitle': '出借或借用 AI 助理',
  'connect.lending.offLine': '讓另一台電腦經由這台電腦,暫時使用你的 AI 助理登入,或向對方借用。',
  'connect.lending.turnOn': '開啟出借',

  'connect.moved.phone': '配對、已配對的手機、通知和公開網址,現在都在「連結 › 手機」。',
  'connect.moved.pcs': '你的其他電腦現在在「連結 › 我的電腦」。',
  'connect.moved.team': '你的團隊現在在「連結 › 團隊」。',
  'connect.moved.lending': '出借現在在「連結 › 出借」。',
  'connect.moved.open': '開啟連結',
};
