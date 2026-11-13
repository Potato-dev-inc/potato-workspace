// One agent on the board: text only, plus the agent's icon. The open button takes the whole tile; a low-risk yes/no
// approval also gets its two answers beside it (a separate row, so no button sits inside another button).
import type { MouseEvent } from 'react';
import { useT } from '../../../i18n';
import { AgentLogo } from '../../common/AgentLogo';
import type { PromptChoice } from '../../../lib/cockpit-api';
import { elapsedParts, type BoardTile as Tile } from './boardModel';

export interface BoardTileProps {
  tile: Tile;
  now: number;
  onOpen: (paneId: string) => void;
  onAnswer: (tile: Tile, choice: PromptChoice, event: MouseEvent<HTMLButtonElement>) => void;
}

export function BoardTile({ tile, now, onOpen, onAnswer }: BoardTileProps) {
  const t = useT();
  const elapsed = tile.since === null ? null : elapsedParts(now - tile.since);
  const age = elapsed === null ? null : elapsed.unit === 'now' ? t('board.age.now') : t(elapsed.unit === 'minutes' ? 'board.age.minutes' : 'board.age.hours', { count: elapsed.count });

  return (
    <li className="ck-board-tile" data-column={tile.column} data-pane-id={tile.paneId}>
      <button type="button" className="ck-board-open" onClick={() => onOpen(tile.paneId)}>
        <span className="ck-board-tile-top">
          <AgentLogo id={tile.agentType} name={tile.name} size={13} decorative />
          <span className="ck-board-name">{tile.name}</span>
        </span>
        <span className="ck-board-project">{tile.project}</span>
        {tile.activity && <span className="ck-board-activity">{tile.activity}</span>}
        {age && <span className="ck-board-age">{age}</span>}
      </button>
      {tile.quickChoices.length > 0 && (
        <div className="ck-board-answers" role="group" aria-label={t('board.answerGroup')}>
          {tile.quickChoices.map((choice) => (
            <button key={choice.id} type="button" className="ck-board-answer" onClick={(event) => onAnswer(tile, choice, event)}>
              {choice.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
