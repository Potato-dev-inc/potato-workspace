// The agent board (Ctrl+0): every agent in three columns, Needs you / Working / Done. A tile opens its agent. A low-risk
// yes/no approval can be answered on the tile, through the same answer call the Inbox card uses. Esc closes the board.
import { useEffect, useMemo, type MouseEvent } from 'react';
import type { CockpitApi } from '../../../hooks/useCockpit';
import { useT } from '../../../i18n';
import { gestureOf } from '../../../lib/user-gesture';
import type { NeedsYouItem } from '../../../lib/attention';
import { usePaneActivity } from '../../../lib/pane-activity';
import { projectWithCopy } from '../shell-labels';
import { BOARD_COLUMNS, buildBoard, type BoardColumn, type BoardTile as Tile } from './boardModel';
import { BoardTile } from './BoardTile';
import { useThrottledValue } from './useThrottledValue';

/** The board redraws at most this often (ms). */
export const BOARD_REFRESH_MS = 1000;

export interface AgentBoardProps {
  c: CockpitApi;
  needsYou: ReadonlyArray<NeedsYouItem>;
  onClose: () => void;
}

export function AgentBoard({ c, needsYou, onClose }: AgentBoardProps) {
  const t = useT();
  const activity = useThrottledValue(usePaneActivity(), BOARD_REFRESH_MS);

  const columns = useMemo(
    () =>
      buildBoard({
        panes: c.registry.paneList,
        names: c.names,
        prompts: c.prompts,
        statusSince: c.statusSince,
        needsYou,
        activity,
        projectOf: (cwd) => projectWithCopy(cwd),
      }),
    [c.registry.paneList, c.names, c.prompts, c.statusSince, needsYou, activity],
  );

  // Esc closes the board, unless a box, menu or dialog opened over it takes the key first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const answer = (tile: Tile, choice: { id: string; label: string }, event: MouseEvent<HTMLButtonElement>) => {
    if (!tile.promptId) return;
    void c.answer(tile.paneId, tile.promptId, choice.id, choice.label, gestureOf(event));
  };

  return (
    <section className="ck-board" aria-labelledby="ck-board-title">
      <header className="ck-board-head">
        <div>
          <h1 id="ck-board-title" className="ck-title">{t('board.title')}</h1>
          <p className="ck-sub">{t('board.sub')}</p>
        </div>
        <button type="button" className="ck-btn ck-btn--secondary" onClick={onClose}>
          {t('board.close')}
        </button>
      </header>
      <div className="ck-board-cols">
        {BOARD_COLUMNS.map((column: BoardColumn) => {
          const tiles = columns[column];
          const headId = `ck-board-${column}`;
          return (
            <section key={column} className={`ck-board-col ck-board-col--${column}`} aria-labelledby={headId}>
              <h2 id={headId} className="ck-board-col-head">
                {t(`board.col.${column}`)} <span className="ck-board-count">{tiles.length}</span>
              </h2>
              {tiles.length === 0 ? (
                <p className="ck-board-empty">{t(`board.empty.${column}`)}</p>
              ) : (
                <ul className="ck-board-list">
                  {tiles.map((tile) => (
                    <BoardTile key={tile.paneId} tile={tile} now={c.now} onOpen={(id) => c.select(id)} onAnswer={answer} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
