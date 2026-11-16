// One minion, read-only: the chat it has with the work it does, with no message box, no slash menu, no model picker and
// no Allow buttons. Its agent runs it; the person can read it and stop it. The header, with Back / fill / close, is the
// column's (TaskColumn). A command or terminal uses the same view in later slices.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { useSessionChat } from '../../../hooks/useSessionChat';
import { ChatPaneContext } from '../../chat/ChatPane';
import { SessionChatView } from '../../chat/SessionChatView';
import { StopSquare, type HelperRow } from './BackgroundSection';

/** The task the minion was given: the first message of its chat. */
function taskText(turns: ReadonlyArray<{ user: { text: string } | null }>): string {
  return turns.find((turn) => turn.user)?.user?.text.trim() ?? '';
}

export function TaskSideView({ row, parentName, onStop }: { row: HelperRow; parentName: string; onStop?: (id: string) => Promise<void> | void }) {
  const t = useT();
  const chat = useSessionChat(row.id, true);
  const [more, setMore] = useState(false);
  const task = taskText(chat.turns);
  const running = row.status === 'running';
  const waiting = row.status === 'waiting_input';
  return (
    <div className="tk-view" data-testid="task-side-view" data-status={row.status}>
      <div className="tk-meta">
        {task && (
          <p className={`tk-line tk-task${more ? ' is-open' : ''}`}>
            <span className="tk-k">{t('task.taskLine')}</span> <span className="tk-task-text">{task}</span>
            {task.length > 90 && (
              <button type="button" className="tk-more" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? t('task.less') : t('task.more')}
              </button>
            )}
          </p>
        )}
      </div>
      <div className="tk-chat">
        <ChatPaneContext.Provider value={row.id}>
          <SessionChatView
            state={chat.state}
            reason={chat.reason}
            waitingFor={chat.waitingFor}
            source={chat.source}
            turns={chat.turns}
            model={chat.model}
            cliVersion={chat.cliVersion}
            paneId={row.id}
            readOnly
            earlier={chat.earlier}
          />
        </ChatPaneContext.Provider>
      </div>
      <footer className="tk-foot">
        {waiting && <p className="tk-ask">{t('task.waitingYou', { name: parentName })}</p>}
        <div className="tk-foot-row">
          <p className="tk-note">{t('task.minionOf', { name: parentName })}</p>
          {(running || waiting) && onStop && <StopSquare name={row.title} onStop={() => onStop(row.id)} />}
        </div>
      </footer>
    </div>
  );
}
