// The rules the screen scan (scripts/roam.mjs) applies to the text a rendered screen shows. Pure functions on
// strings, so they are tested on samples (roam-rules.test.ts). The scan itself needs a browser; this does not.
import { BANNED_TERMS, findSynonymClashes } from './glossary';

export type RoamRule =
  | 'banned-term'
  | 'raw-error'
  | 'backtick'
  | 'dev-build'
  | 'caps-code'
  | 'synonym'
  | 'icon-button-no-label'
  | 'clipped'
  | 'page-overflow'
  | 'not-rendered'
  | 'js-error';

export const ROAM_RULES: readonly RoamRule[] = [
  'banned-term',
  'raw-error',
  'backtick',
  'dev-build',
  'caps-code',
  'synonym',
  'icon-button-no-label',
  'clipped',
  'page-overflow',
  'not-rendered',
  'js-error',
];

export interface RoamHit {
  rule: RoamRule;
  text: string;
}

/** An allowed false alarm. `reason` is required: an entry nobody can explain is deleted. */
export interface AllowEntry {
  rule: RoamRule;
  /** Scenario name pattern (regular expression source). Default: every screen. */
  screen?: string;
  /** Substring of the hit text. Default: any text of that rule. */
  text?: string;
  reason: string;
}

const RAW_ERRORS: { pattern: RegExp; what: string }[] = [
  { pattern: /Cannot read propert/i, what: 'JavaScript error' },
  { pattern: /\[object Object\]/, what: '[object Object]' },
  { pattern: /\bundefined\b/, what: 'undefined' },
  { pattern: /\bnull\b/, what: 'null' },
  { pattern: /\bNaN\b/, what: 'NaN' },
  { pattern: /\b(Type|Reference|Syntax|Range)Error\b/, what: 'JavaScript error name' },
  { pattern: /(^|\s)Error: /, what: 'Error: prefix' },
  { pattern: /\bErr\(/, what: 'Rust Err(' },
  { pattern: /\bat \S+ \((?:[A-Za-z]:|\/|https?:)/, what: 'stack trace' },
  { pattern: /\b[A-Za-z]:\\[^\s\\]/, what: 'Windows file path' },
  { pattern: /(^|\s)\/(Users|home)\/[^\s/]+/, what: 'home folder path' },
];

const CAPS_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

const clip = (text: string, n = 140): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Rule hits for the visible strings of one screen. `screen` is the scenario name (the synonym table has exceptions). */
export function checkTexts(texts: string[], screen = ''): RoamHit[] {
  const hits: RoamHit[] = [];
  const seen = new Set<string>();
  const add = (rule: RoamRule, text: string): void => {
    const key = `${rule}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ rule, text: clip(text) });
  };
  for (const text of texts) {
    for (const b of BANNED_TERMS) if (b.pattern.test(text)) add('banned-term', `${text}  (say "${b.use}")`);
    for (const e of RAW_ERRORS) if (e.pattern.test(text)) add('raw-error', `${text}  (${e.what})`);
    if (text.includes('`')) add('backtick', text);
    if (/dev build/i.test(text)) add('dev-build', text);
    const caps = CAPS_CODE.exec(text);
    if (caps) add('caps-code', `${text}  (${caps[0]})`);
  }
  for (const c of findSynonymClashes(texts, screen)) add('synonym', `${c.found.join(' / ')} for one thing: ${c.concept}  (keep "${c.use}")`);
  return hits;
}

function matches(hit: RoamHit, screen: string, e: AllowEntry): boolean {
  if (e.rule !== hit.rule) return false;
  if (e.screen && !new RegExp(e.screen).test(screen)) return false;
  if (e.text && !hit.text.includes(e.text)) return false;
  return true;
}

/** Splits hits into those still to fix and those on the allow list. */
export function applyAllow(hits: RoamHit[], screen: string, allow: AllowEntry[]): { open: RoamHit[]; allowed: RoamHit[] } {
  const open: RoamHit[] = [];
  const allowed: RoamHit[] = [];
  for (const hit of hits) (allow.some((e) => matches(hit, screen, e)) ? allowed : open).push(hit);
  return { open, allowed };
}

/** Problems with the allow list itself (no reason, unknown rule, bad pattern). Empty = fine. */
export function checkAllowList(allow: unknown): string[] {
  if (!Array.isArray(allow)) return ['the allow list must be an array'];
  const problems: string[] = [];
  allow.forEach((raw, i) => {
    const e = raw as Partial<AllowEntry> | null;
    if (!e || typeof e !== 'object') {
      problems.push(`#${i}: not an object`);
      return;
    }
    if (!e.rule || !ROAM_RULES.includes(e.rule)) problems.push(`#${i}: unknown rule "${String(e.rule)}"`);
    if (!e.reason || !String(e.reason).trim()) problems.push(`#${i}: a reason is required`);
    if (e.screen) {
      try {
        new RegExp(e.screen);
      } catch {
        problems.push(`#${i}: screen is not a valid pattern`);
      }
    }
  });
  return problems;
}

/** Escapes a cell for a markdown table. */
export const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
