// The strip under a chat that works on a copy ("Work on a copy"): what the copy changed and the two ways out.
// "Keep the changes" brings them into the project; "Throw away the copy" waits in the undo bar, then it is final.
import { useT } from '../../i18n';
import { copyFilesText, type ChatCopySummary } from '../../lib/chatCopy';

export function ChatCopyBar({
  kind,
  summary,
  busy,
  onKeep,
  onThrowAway,
}: {
  kind: 'git' | 'plain';
  summary: ChatCopySummary | null;
  busy: boolean;
  onKeep: () => void;
  onThrowAway: () => void;
}) {
  const t = useT();
  const files = summary?.files ?? 0;
  const totals = summary && summary.additions !== null && summary.files > 0 ? ` · +${summary.additions} −${summary.deletions ?? 0}` : '';
  return (
    <section className="ck-acp-result ck-chatcopy" aria-label={t('chatCopy.label')} data-testid="chat-copy-bar">
      <span className="ck-caption">{t(kind === 'plain' ? 'chatCopy.trial' : 'chatCopy.copy')}</span>
      <span className="ck-acp-result-text">{summary ? `${copyFilesText(files)}${totals}` : t('chatCopy.reading')}</span>
      <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={busy || files === 0} onClick={onKeep} title={files === 0 ? t('chatCopy.nothingToKeep') : undefined}>
        {t('chatCopy.keep')}
      </button>
      <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={busy} onClick={onThrowAway}>
        {t('chatCopy.throwAway')}
      </button>
    </section>
  );
}
