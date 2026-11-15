// Takes the chat's place in a pane while the chat is open in its own window. Same chat, same agent: only the view moved.
import { useState } from 'react';
import { putChatBack } from '../../lib/tab-windows';
import { useT } from '../../i18n';

export function ChatOutNote({ paneId }: { paneId: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  return (
    <div className="ck-tabout" data-testid="chat-in-window">
      <h2>{t('tabwin.chatOutTitle')}</h2>
      <p>{t('tabwin.chatOutBody')}</p>
      <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" title={t('tabwin.putBackTip')} data-testid="chat-put-back" onClick={() => putChatBack(paneId).catch(() => setFailed(true))}>
        {t('tabwin.putBack')}
      </button>
      {failed && <p role="alert">{t('tabwin.failed')}</p>}
    </div>
  );
}
