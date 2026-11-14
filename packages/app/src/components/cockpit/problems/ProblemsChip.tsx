// "2 problems" in the status bar, and the sheet it opens: everything that failed, newest first, what happened in plain words,
// which agent, fixed or not, and one way out for each row. Fixed rows fade; Clear removes them. A row never shows a code.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage, useT } from '../../../i18n';
import { clearFixedProblems, openProblems, useProblems, type Problem, type ProblemWay } from '../../../lib/problems';
import { useCopy } from '../../chat/useCopy';
import '../../../styles/problems.css';

export interface ProblemActions {
  openChat: (paneId: string) => void;
  signIn: (agentId: string) => void;
  tryAgain: (agentId: string) => void;
}

const WAY_KEY = {
  open_chat: 'flow.problems.openChat',
  sign_in: 'flow.problems.signIn',
  try_again: 'flow.problems.tryAgain',
  copy: 'flow.problems.copy',
} as const satisfies Record<ProblemWay, string>;

/** The time in the app's own language (下午 2:05 in Traditional Chinese), not the PC's. */
function clock(at: number, lang: string): string {
  return new Date(at).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' });
}

function Row({ p, actions, onDone }: { p: Problem; actions: ProblemActions; onDone: () => void }) {
  const t = useT();
  const lang = useLanguage();
  const { state, copy } = useCopy();
  const way = p.way;
  const main = () => {
    if (way === 'open_chat' && p.paneId) actions.openChat(p.paneId);
    else if (way === 'sign_in' && p.agentId) actions.signIn(p.agentId);
    else if (way === 'try_again' && p.agentId) actions.tryAgain(p.agentId);
    onDone();
  };
  // A way that cannot be walked (no chat, no agent known) leaves only Copy details.
  const walkable = (way === 'open_chat' && !!p.paneId) || ((way === 'sign_in' || way === 'try_again') && !!p.agentId);
  return (
    <li className={`pb-row${p.fixed ? ' is-fixed' : ''}`} data-problem={p.id}>
      <div className="pb-what">{p.what}</div>
      <div className="pb-meta">{[p.agent, clock(p.at, lang), p.fixed ? t('flow.problems.fixed') : t('flow.problems.notFixed')].filter(Boolean).join(' · ')}</div>
      {!p.fixed && (
        <div className="pb-acts">
          {walkable && (
            <button type="button" className="ck-btn ck-btn--secondary" onClick={main}>
              {t(WAY_KEY[way])}
            </button>
          )}
          <button type="button" className="pb-link" onClick={() => void copy(p.details ?? p.what)}>
            {state === 'idle' ? t('flow.problems.copy') : t('flow.error.copied')}
          </button>
        </div>
      )}
    </li>
  );
}

export function ProblemsChip({ actions }: { actions: ProblemActions }) {
  const t = useT();
  const rows = useProblems();
  const open = openProblems(rows).length;
  const [shown, setShown] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shown) return;
    sheet.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShown(false);
      button.current?.focus();
    };
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!sheet.current?.contains(target) && !button.current?.contains(target)) setShown(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', away);
    };
  }, [shown]);

  if (open === 0 && !shown) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ck-sb-count pb-chip"
        aria-haspopup="dialog"
        aria-expanded={shown}
        onClick={() => setShown((v) => !v)}
        data-testid="problems-chip"
      >
        {t('flow.problems.count', { count: open })}
      </button>
      {shown &&
        createPortal(
          <div ref={sheet} className="pb-sheet" role="dialog" aria-label={t('flow.problems.title')} data-testid="problems-sheet">
            <div className="pb-top">
              <span className="pb-title">{t('flow.problems.title')}</span>
              {rows.some((p) => p.fixed) && (
                <button type="button" className="pb-link" onClick={clearFixedProblems}>
                  {t('flow.problems.clear')}
                </button>
              )}
            </div>
            {rows.length === 0 ? (
              <p className="pb-empty">{t('flow.problems.none')}</p>
            ) : (
              <ul className="pb-list">
                {rows.map((p) => (
                  <Row key={p.id} p={p} actions={actions} onDone={() => setShown(false)} />
                ))}
              </ul>
            )}
          </div>,
          document.querySelector('.cockpit') ?? document.body,
        )}
    </>
  );
}
