// The agent-version sentences Rust writes in English ("Codex 0.167.1 changed its screens..."), in the app's language.
// A sentence that is not one of these stays as it came.
import { getLanguage, t } from '../i18n';

const RULES: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^(.+) changed its screens\. Potato Workspace will ask you before acting\.$/, (m) => t('r15.canary.changed', { name: m[1] })],
  [/^Potato Workspace has not been tested with (.+) yet\. It will ask you before closing a start-up notice, and it will not keep one ready in advance\.$/, (m) => t('r15.canary.untested', { name: m[1] })],
  [/^Not installed on this computer\.$/, () => t('r15.canary.notInstalled')],
  [/^(.+) was checked on this computer\. Its screens read fine\.$/, (m) => t('r15.canary.checkedFine', { name: m[1] })],
  [/^(.+) is a version Potato Workspace has been tested with\.$/, (m) => t('r15.canary.tested', { name: m[1] })],
  [/^Could not read the version of (.+)\.$/, (m) => t('r15.canary.noVersion', { name: m[1] })],
  [/^(.+) has no version limit set\.$/, (m) => t('r15.canary.noLimit', { name: m[1] })],
];

export function canaryText(text: string): string {
  if (getLanguage() === 'en') return text;
  for (const [pattern, say] of RULES) {
    const hit = pattern.exec(text);
    if (hit) return say(hit);
  }
  return text;
}
