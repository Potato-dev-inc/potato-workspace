// The agent's own setting names and choices (ACP config options) arrive in English. The well-known ones are said in the
// app's language; anything else the agent wrote stays exactly as it wrote it (only a whole-text match is ever translated).
import { getLanguage, t, type MessageKey } from '../../i18n';
import type { ConfigChip } from '../../lib/acpChat';

const WORDS: Record<string, MessageKey> = {
  default: 'r10.chip.default',
  manual: 'r10.chip.manual',
  auto: 'r10.chip.auto',
  plan: 'r10.chip.plan',
  'accept edits': 'r10.chip.acceptEdits',
  'full access': 'r10.chip.fullAccess',
  'bypass permissions': 'r10.chip.bypass',
  low: 'r10.chip.low',
  medium: 'r10.chip.medium',
  high: 'r10.chip.high',
  max: 'r10.chip.max',
  extra: 'r15.chip.extra',
  'extra high': 'r15.chip.extra',
  xhigh: 'r15.chip.extra',
  'x high': 'r15.chip.extra',
  minimal: 'r15.chip.minimal',
  'fast mode': 'r10.chip.fastMode',
  agent: 'r10.chip.agent',
  model: 'r10.chip.model',
  mode: 'r10.chip.mode',
  effort: 'r10.chip.effort',
  off: 'r10.chip.off',
  on: 'r10.chip.on',
};

/** A well-known setting word in the app's language; any other text comes back unchanged. */
export function chipWord(text: string): string {
  if (getLanguage() === 'en') return text;
  const key = WORDS[text.trim().toLowerCase().replace(/[\s_-]+/g, ' ')];
  return key ? t(key) : text;
}

/** The chip with its name and its choices' names said in the app's language (values and notes are untouched). */
export function localizeChip(chip: ConfigChip): ConfigChip {
  return { ...chip, label: chipWord(chip.label), choices: chip.choices.map((c) => ({ ...c, name: chipWord(c.name) })) };
}
