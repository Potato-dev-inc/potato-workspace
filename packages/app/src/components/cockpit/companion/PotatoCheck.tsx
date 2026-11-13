// "Check on this one" (proposal 37): Potato looks at one agent and says in two lines what it is doing and whether it
// needs anything, then offers: Watch it for me, Nudge it, Thanks. It only reads. "Nudge it" is the one thing that
// writes, and only after its own click (the words are shown on the screen first).
import { useEffect, useRef, useState } from 'react';
import { CHECK_QUESTION, NOTED_KEY, NUDGE_TEXT, fallbackLine, paneTurns, twoLines } from '../../../lib/potatoCheck';
import { buildSideContext, tauriSideQuestionApi, type SideQuestionApi } from '../../../lib/sideQuestion';
import { useT } from '../../../i18n';
import { DotSpinner } from '../DotSpinner';
import { CompanionBubble, useAnchor } from './CompanionBubble';

export interface CheckTarget {
  paneId: string;
  /** The agent's name as the sidebar shows it. */
  agent: string;
  status: string;
  needsYou: boolean;
  /** The pane's one-line activity text, when it has one. */
  activity: string | null;
}

type Phase =
  | { kind: 'note' }
  | { kind: 'thinking' }
  | { kind: 'answer'; lines: string[]; readFromScreen: boolean }
  | { kind: 'error' };

type Done = null | 'watching' | 'nudged';

const readNoted = (): boolean => {
  try {
    return localStorage.getItem(NOTED_KEY) === '1';
  } catch {
    return false;
  }
};
const writeNoted = (): void => {
  try {
    localStorage.setItem(NOTED_KEY, '1');
  } catch {
    // Blocked storage: the note may show again next time.
  }
};

let nextAsk = 0;

export function PotatoCheck({
  companionName,
  target,
  anchorSelector,
  onWatch,
  onNudge,
  onClose,
  api = tauriSideQuestionApi,
}: {
  companionName: string;
  target: CheckTarget;
  anchorSelector: string;
  onWatch: () => void;
  onNudge: () => void;
  onClose: () => void;
  api?: SideQuestionApi;
}) {
  const t = useT();
  const anchor = useAnchor(anchorSelector, target.paneId);
  const turns = useRef(paneTurns(target.paneId));
  // No chat to read (a terminal agent, or a chat not opened yet): the answer comes from the pane's status and activity line, no ask is made.
  const hasChat = turns.current !== null;
  const [phase, setPhase] = useState<Phase>(() => (!hasChat ? { kind: 'thinking' } : readNoted() ? { kind: 'thinking' } : { kind: 'note' }));
  const [done, setDone] = useState<Done>(null);
  const alive = useRef(true);
  const goRef = useRef<HTMLButtonElement>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // thinking: read the chat through the side question, or fall back to the pane's own status.
  const thinking = phase.kind === 'thinking';
  useEffect(() => {
    if (!thinking) return;
    const cur = targetRef.current;
    if (!turns.current) {
      const line = fallbackLine(cur.status, cur.needsYou, cur.activity);
      setPhase({ kind: 'answer', lines: [t(line.key, line.vars)], readFromScreen: true });
      return;
    }
    const context = buildSideContext(turns.current);
    const askId = `potato-${Date.now().toString(36)}-${(nextAsk++).toString(36)}`;
    api
      .target(cur.paneId)
      .then((who) => {
        if (!who) throw new Error('no helper');
        return api.ask(cur.paneId, { ask_id: askId, question: CHECK_QUESTION, context });
      })
      .then((result) => {
        if (!alive.current) return;
        const lines = result.ok && result.answer ? twoLines(result.answer) : [];
        setPhase(lines.length > 0 ? { kind: 'answer', lines, readFromScreen: false } : { kind: 'error' });
      })
      .catch(() => {
        if (alive.current) setPhase({ kind: 'error' });
      });
  }, [thinking, api, t]);

  useEffect(() => {
    if (phase.kind === 'note') goRef.current?.focus();
  }, [phase.kind]);

  const title = t('potato.check.title', { agent: target.agent });
  return (
    <CompanionBubble face={phase.kind === 'error' ? 'error' : phase.kind === 'thinking' ? 'working' : 'happy'} label={t('potato.check.region', { name: companionName, agent: target.agent })} anchor={anchor} onClose={onClose} testId="potato-check">
      <p className="ck-pbubble-title">{title}</p>
      {phase.kind === 'note' && (
        <>
          <p className="ck-pbubble-line">{t('potato.check.note')}</p>
          <div className="ck-pbubble-actions">
            <button
              ref={goRef}
              type="button"
              className="ck-btn ck-btn--tiny ck-btn--primary"
              onClick={() => {
                writeNoted();
                setPhase({ kind: 'thinking' });
              }}
            >
              {t('potato.check.go')}
            </button>
            <button type="button" className="ck-btn ck-btn--tiny ck-btn--plain" onClick={onClose}>
              {t('potato.check.cancel')}
            </button>
          </div>
        </>
      )}
      {phase.kind === 'thinking' && (
        <p className="ck-pbubble-thinking">
          <DotSpinner status="running" label={t('potato.check.thinking', { agent: target.agent })} />
          <span>{t('potato.check.thinking', { agent: target.agent })}</span>
        </p>
      )}
      {phase.kind === 'error' && (
        <>
          <p className="ck-pbubble-line">{t('potato.check.error', { agent: target.agent })}</p>
          <div className="ck-pbubble-actions">
            <button type="button" className="ck-btn ck-btn--tiny ck-btn--plain" onClick={onClose}>
              {t('potato.check.thanks')}
            </button>
          </div>
        </>
      )}
      {phase.kind === 'answer' && (
        <>
          {phase.lines.map((line, i) => (
            <p className="ck-pbubble-line" key={i}>
              {line}
            </p>
          ))}
          {phase.readFromScreen && <p className="ck-pbubble-note">{t('potato.check.noChat', { agent: target.agent })}</p>}
          {done === 'watching' && <p className="ck-pbubble-note">{t('potato.check.watching', { agent: target.agent })}</p>}
          {done === 'nudged' && <p className="ck-pbubble-note">{t('potato.check.nudged')}</p>}
          {done === null && <p className="ck-pbubble-note">{t('potato.check.nudgeWords', { text: NUDGE_TEXT })}</p>}
          <div className="ck-pbubble-actions">
            {done === null && (
              <>
                <button
                  type="button"
                  className="ck-btn ck-btn--tiny ck-btn--secondary"
                  onClick={() => {
                    onWatch();
                    setDone('watching');
                  }}
                >
                  {t('potato.check.watch')}
                </button>
                <button
                  type="button"
                  className="ck-btn ck-btn--tiny ck-btn--secondary"
                  onClick={() => {
                    onNudge();
                    setDone('nudged');
                  }}
                >
                  {t('potato.check.nudge')}
                </button>
              </>
            )}
            <button type="button" className="ck-btn ck-btn--tiny ck-btn--plain" onClick={onClose}>
              {t('potato.check.thanks')}
            </button>
          </div>
        </>
      )}
    </CompanionBubble>
  );
}
