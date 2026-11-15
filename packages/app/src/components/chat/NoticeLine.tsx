// A notice of the session (context compacted, an error, a pull request opened) as a thin centred line between two
// rules. Plain text only: a link's address is the tooltip, not a link.

import { useT } from '../../i18n';

export interface NoticeLineProps {
  text: string;
  /** `error` is shown heavier; other kinds are the same line. */
  kind: string;
  url?: string | null;
}

export function NoticeLine({ text, kind, url }: NoticeLineProps) {
  const t = useT();
  const isError = kind === 'error';
  // The app's own automatic restart is worded here, in the person's language; the text from the app is English.
  const shown = kind === 'restarted' ? t('chatUx.restarted') : text;
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px] text-pm-muted ck-chat-notice" data-notice={kind}>
      <span aria-hidden="true" className="h-px flex-1 bg-pm-border ck-chat-rule" />
      <span title={url ?? undefined} className={`min-w-0 text-center break-words ck-chat-notice-text${isError ? ' ck-chat-notice-text--error' : ''}`}>
        {shown}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-pm-border ck-chat-rule" />
    </div>
  );
}
