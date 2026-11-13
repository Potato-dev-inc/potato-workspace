import { t, useT } from '../../i18n';
import { tauriAskbarApi, useAskNotices, type AskbarApi, type AskNotice } from '../../lib/askbar';
import '../../styles/ask-notices.css';
import { CardButton, InboxCard } from './InboxCard';

const PREVIEW_CHARS = 160;

/** The text under the question: the answer in one short line, or the error when it failed. */
export function noticePreview(notice: AskNotice): string {
  const raw = notice.result.ok ? (notice.result.answer ?? '') : (notice.result.error?.message ?? t('inboxCards.ask.noAnswer'));
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > PREVIEW_CHARS ? `${oneLine.slice(0, PREVIEW_CHARS)}…` : oneLine;
}

/** Answers from the Ask bar that arrived while the bar was hidden. Renders nothing when there are none. */
export function AskNotices({ api = tauriAskbarApi }: { api?: AskbarApi }) {
  const tr = useT();
  const { notices, dismiss, open } = useAskNotices(api);
  if (notices.length === 0) return null;
  return (
    <ul className="ib-list" aria-label={tr('inboxCards.ask.listLabel')}>
      {notices.map((n) => (
        <li key={n.id}>
          <InboxCard
            kind="answer"
            glyph="notice"
            info
            title={tr('inboxCards.ask.title', { agent: n.agent_label })}
            reason={<span className="ib-oneline">{n.question}</span>}
            body={<p className="ib-clamp">{noticePreview(n)}</p>}
            data={{ 'data-ask-notice': n.id }}
            actions={
              <CardButton tone="secondary" role="open" onClick={() => open(n.id)}>
                {tr('inboxCards.open')}
              </CardButton>
            }
            more={
              <CardButton tone="plain" role="dismiss" onClick={() => dismiss(n.id)}>
                {tr('inboxCards.dismiss')}
              </CardButton>
            }
          />
        </li>
      ))}
    </ul>
  );
}
