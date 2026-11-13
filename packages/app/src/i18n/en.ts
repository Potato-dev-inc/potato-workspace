// English: the source of truth. Every message lives in a group file under ./en; zh-TW.ts mirrors the same keys.
// Plural messages are written as `<key>_one` and `<key>_other` and called as t('<key>', { count }).
import { common } from './en/common';
import { sidebar } from './en/sidebar';
import { inbox } from './en/inbox';
import { status } from './en/status';
import { newAgent } from './en/newAgent';
import { pane } from './en/pane';
import { addAgent } from './en/addAgent';
import { settings } from './en/settings';
import { firstRun } from './en/firstRun';
import { inboxCards } from './en/inboxCards';
import { lookFeel } from './en/lookFeel';
import { risk } from './en/risk';
import { state } from './en/state';
import { overview } from './en/overview';
import { team } from './en/team';

export const en = {
  ...common,
  ...sidebar,
  ...inbox,
  ...status,
  ...newAgent,
  ...pane,
  ...addAgent,
  ...settings,
  ...firstRun,
  ...inboxCards,
  ...lookFeel,
  ...risk,
  ...state,
  ...overview,
  ...team,
} as const;

export type MessageKey = Exclude<keyof typeof en, `${string}_one` | `${string}_other`> | PluralKey;
export type PluralKey = keyof typeof en extends infer K ? (K extends `${infer B}_other` ? B : never) : never;
export type EnglishKey = keyof typeof en;
