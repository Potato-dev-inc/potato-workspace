// Short time units in the app's language: "48s" / "48 秒", "2h 14m" / "2 小時 14 分鐘". Pure.
import { t, type MessageKey } from '../i18n';

const KEYS = { s: 'r10.unit.s', m: 'r10.unit.m', h: 'r10.unit.h', d: 'r10.unit.d' } as const satisfies Record<string, MessageKey>;

/** One amount of time: `unit('m', 5)` is "5m" (English) or "5 分鐘" (zh-TW). */
export const unit = (u: keyof typeof KEYS, n: number): string => t(KEYS[u], { n });

/** "Less than a second / minute": "<1s", "<1m" or its zh-TW form. */
export const lessThan = (u: 's' | 'm'): string => t(u === 's' ? 'r10.unit.lt1s' : 'r10.unit.lt1m');
