// The save sheet shows the page or Markdown file Rust made, and the saved file is exactly that text (English). For a person who reads
// another language the PREVIEW says its fixed labels in their language; the text that is saved is never changed.
import { getLanguage, t, type MessageKey } from '../i18n';
import { formatElapsed } from '../components/cockpit/model';
import { endingText } from '../components/chat/chatFormat';
import type { ExportFormat } from './chatExport';

const secs = (d: string): number => {
  const [, h, m, s] = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(d.trim()) ?? [];
  return ((+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0)) * 1000;
};

/** "Interrupted · Worked for 1m 4s" in words of the app's language. */
const endWords = (line: string): string =>
  line.startsWith('Done') ? endingText(line) : line
    .split(' · ')
    .map((p) => {
      if (p === 'Interrupted') return t('r11.exp.interrupted');
      if (p === 'Failed') return t('r11.exp.failed');
      const m = /^Worked for (.+)$/.exec(p);
      return m ? t('r11.exp.worked', { time: formatElapsed(secs(m[1])) }) : p;
    })
    .join(' · ');

/** The words an agent puts first on a tool line ("edit", "Create File u1.txt"), in the app's language; anything else stays. */
const TOOL_NAMES: Record<string, MessageKey> = { edit: 'r15.exp.tool.edit', write: 'r15.exp.tool.write', read: 'r15.exp.tool.read', delete: 'r15.exp.tool.delete' };
const FILE_VERBS: Record<string, MessageKey> = { 'Create File': 'r15.exp.file.create', 'Edit File': 'r15.exp.file.edit', 'Read File': 'r15.exp.file.read', 'Delete File': 'r15.exp.file.delete', File: 'r15.exp.file.file' };
const toolWords = (line: string): string => line.replace(/^(Create File|Edit File|Read File|Delete File|File)(?= |$)/, (w) => t(FILE_VERBS[w]));

/** The preview text with its fixed labels translated (a no-op in English). */
export function localizeExportPreview(text: string, format: ExportFormat): string {
  if (getLanguage() === 'en') return text;
  const more = (n: string) => t('r11.exp.more', { n });
  const turns = (a: string, b: string) => t('r11.exp.turns', { from: a, to: b });
  if (format === 'markdown') {
    return text
      .replace(/^\*\*You\*\*$/gm, `**${t('r11.exp.you')}**`)
      .replace(/^\*\*Task list\*\*$/gm, `**${t('r11.exp.tasks')}**`)
      .replace(/^_Nothing to show\._$/gm, `_${t('r11.exp.empty')}_`)
      .replace(/^_Saved from Potato Workspace_$/gm, `_${t('r11.exp.footer')}_`)
      .replace(/^Turns (\d+) to (\d+)$/gm, (_s, a: string, b: string) => turns(a, b))
      .replace(/^_… (\d+) more lines_$/gm, (_s, n: string) => `_${more(n)}_`)
      .replace(/^_((?:Interrupted|Failed|Worked for|Done)[^_]*)_$/gm, (_s, l: string) => `_${endWords(l)}_`)
      .replace(/^_(You stopped it|Probably signed out|The turn ended with no answer)_$/gm, (_s, l: string) => `_${endingText(l)}_`);
  }
  return text
    .replace('<html lang="en">', `<html lang="${getLanguage()}">`)
    .replace('<p class="eyebrow">Chat</p>', `<p class="eyebrow">${t('r11.exp.chat')}</p>`)
    .replace(/<h3>You<\/h3>/g, `<h3>${t('r11.exp.you')}</h3>`)
    .replace(/<h3>Task list<\/h3>/g, `<h3>${t('r11.exp.tasks')}</h3>`)
    .replace('<p class="empty">Nothing to show.</p>', `<p class="empty">${t('r11.exp.empty')}</p>`)
    .replace('<footer class="foot">Saved from Potato Workspace</footer>', `<footer class="foot">${t('r11.exp.footer')}</footer>`)
    .replace(/<p class="range">Turns (\d+) to (\d+)<\/p>/, (_s, a: string, b: string) => `<p class="range">${turns(a, b)}</p>`)
    .replace(/(<(?:span|p) class="more">)… (\d+) more lines</g, (_s, tag: string, n: string) => `${tag}${more(n)}<`)
    .replace(/(<p class="notice">)([^<]*)(<\/p>)/g, (_s, a: string, body: string, c: string) => `${a}${toolWords(endingText(body))}${c}`)
    .replace(/(<div class="tool"><span class="name">)([^<]*)(<\/span> <span>)([^<]*)(<\/span>)/g, (_s, a: string, name: string, b: string, body: string, c: string) => `${a}${TOOL_NAMES[name] ? t(TOOL_NAMES[name]) : name}${b}${toolWords(body)}${c}`)
    .replace(/(<div class="turn-end"><span>)([^<]*)(<\/span>)/g, (_s, a: string, body: string, c: string) => `${a}${endWords(body)}${c}`);
}
