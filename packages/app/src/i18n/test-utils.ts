// Test helpers for the translation layer (not shipped: only tests import this file).
import { setLanguagePref, setSystemLanguageForTests } from './index';

/** Words that stay English on purpose: brand and agent names, units, file extensions. Extend per screen with `extra`. */
export const ENGLISH_ALLOW = [
  'Potato', 'Workspace', 'Claude', 'Codex', 'Cursor', 'OpenCode', 'Kilo', 'Gemini', 'Copilot', 'Aider', 'Anthropic', 'OpenAI',
  'GitHub', 'Git', 'PR', 'AI', 'API', 'MCP', 'CLI', 'URL', 'HTTP', 'HTTPS', 'ID', 'PC', 'OK', 'Windows', 'Mac', 'Linux',
  'Discord', 'Telegram', 'Chrome', 'npm', 'VS', 'Code', 'Max', 'Pro', 'Plus', 'Free', 'GPT', 'Sonnet', 'Opus', 'Haiku',
  'App', 'Alt', 'Labs', 'min', 'ms', 'px', 'KB', 'MB', 'GB', 'md', 'json', 'ts', 'tsx', 'rs', 'js', 'css', 'toml', 'exe',
];

export function useChinese(): void {
  setSystemLanguageForTests(null);
  setLanguagePref('zh-TW', false);
}

export function useEnglish(): void {
  setSystemLanguageForTests(null);
  setLanguagePref('en', false);
}

const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];

/**
 * Every run of English words that a person would see inside `root`: text, aria-labels, titles, placeholders, alt text.
 * Words in `ENGLISH_ALLOW` (and `extra`) do not count, and neither does text inside `<code>`, `<pre>`, `[data-no-i18n]` or an
 * element whose class contains "mono" (agent output, paths, model ids).
 */
export function visibleEnglish(root: Element, extra: readonly string[] = []): string[] {
  const allow = new Set([...ENGLISH_ALLOW, ...extra].map((w) => w.toLowerCase()));
  const found: string[] = [];
  const skip = (el: Element | null): boolean =>
    !!el?.closest('code, pre, kbd, svg, [data-no-i18n], [class*="mono"], script, style');
  const scan = (text: string, where: string) => {
    const words = text.match(/[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]/g) ?? [];
    const bad = words.filter((w) => w.length > 1 && !allow.has(w.toLowerCase()));
    if (bad.length > 0) found.push(`${where}: ${text.trim()}`);
  };
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!skip(n.parentElement) && n.textContent?.trim()) scan(n.textContent, 'text');
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (skip(el)) continue;
    for (const attr of ATTRS) {
      const value = el.getAttribute(attr);
      if (value?.trim()) scan(value, attr);
    }
  }
  return found;
}
