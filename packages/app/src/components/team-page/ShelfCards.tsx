import { useT } from '../../i18n';
import type { CardView, MineView, Recommended, ShelfKind } from '../../lib/shelf';
import { whoHasLine } from './shelf-model';

// Everything here is shown as plain text: names, the "why" line and commands come from teammates.

/** Skill or Tool: a small icon and the word. */
export function KindChip({ kind }: { kind: ShelfKind }) {
  const t = useT();
  const word = kind === 'skill' ? t('teamHub.shelf.kind.skill') : kind === 'tool' ? t('teamHub.shelf.kind.tool') : t('teamHub.shelf.kind.unknown');
  return (
    <span className="tpg-chip tpg-kind" data-kind={kind}>
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {kind === 'tool' ? <path d="M10.5 2.5a3.5 3.5 0 0 0-3.2 4.8L2.5 12.1l1.4 1.4 4.8-4.8a3.5 3.5 0 0 0 4.8-3.2l-2 2-1.6-.4-.4-1.6z" /> : <path d="M3 3.5h6.5a2 2 0 0 1 2 2V13H5a2 2 0 0 1-2-2zM5.5 6.5h3.5M5.5 9h3.5" />}
      </svg>
      {word}
    </span>
  );
}

function Needs({ names }: { names: string[] }) {
  const t = useT();
  if (names.length === 0) return null;
  return <p className="tpg-note tpg-shelf-needs">{t('teamHub.shelf.needs', { names: names.join(', ') })}</p>;
}

export function SuggestedCard({ card, teamSize, onLook, onDismiss }: { card: CardView; teamSize: number; onLook: () => void; onDismiss: () => void }) {
  const t = useT();
  const who = whoHasLine(card.have, teamSize, false);
  return (
    <li className="tpg-card tpg-shelf-card" data-testid={`shelf-suggested-${card.cardId}`}>
      <div className="tpg-person-head">
        <KindChip kind={card.kind} />
        <span className="tpg-name">{card.name}</span>
      </div>
      <p className="tpg-sub">{t('teamHub.shelf.suggestedBy', { name: card.byName })}</p>
      {card.why && <blockquote className="tpg-shelf-why">{card.why}</blockquote>}
      <Needs names={card.needs} />
      {who && <p className="tpg-sub">{who}</p>}
      {card.unknown && (
        <p className="tpg-note" role="status">
          {t('teamHub.shelf.newer')}
        </p>
      )}
      <div className="tpg-actions">
        {!card.unknown && (
          <button type="button" className="ck-btn ck-btn--primary" onClick={onLook}>
            {t('teamHub.shelf.look')}
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--plain" onClick={onDismiss}>
          {t('teamHub.shelf.notForMe')}
        </button>
      </div>
    </li>
  );
}

export function RecommendedCard({ rec, teamSize, onAdd }: { rec: Recommended; teamSize: number; onAdd: () => void }) {
  const t = useT();
  const who = whoHasLine(rec.have, teamSize, false);
  return (
    <li className="tpg-card tpg-shelf-card" data-testid={`shelf-recommended-${rec.cardId}`}>
      <div className="tpg-person-head">
        <KindChip kind={rec.kind} />
        <span className="tpg-name">{rec.name}</span>
        {rec.here && <span className="tpg-chip">{t('teamHub.shelf.added.chip')}</span>}
      </div>
      <p className="tpg-sub">{t('teamHub.shelf.suggestedBy', { name: rec.byNames.join(', ') })}</p>
      <Needs names={rec.needs} />
      {who && <p className="tpg-sub">{who}</p>}
      {rec.unknown && (
        <p className="tpg-note" role="status">
          {t('teamHub.shelf.newer')}
        </p>
      )}
      {!rec.here && !rec.unknown && (
        <div className="tpg-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={onAdd}>
            {t('teamHub.shelf.add')}
          </button>
        </div>
      )}
    </li>
  );
}

export function MineRow({ item, teamSize, onSuggest }: { item: MineView; teamSize: number; onSuggest: () => void }) {
  const t = useT();
  const who = whoHasLine(item.have, teamSize, true);
  const reasonId = `shelf-reason-${item.id}`;
  return (
    <li className="tpg-card tpg-shelf-card" data-testid={`shelf-mine-${item.id}`}>
      <div className="tpg-person-head">
        <KindChip kind={item.kind} />
        <span className="tpg-name">{item.name}</span>
        {item.suggested && <span className="tpg-chip">{t('teamHub.shelf.sent.chip')}</span>}
      </div>
      {item.agents.length > 0 && <p className="tpg-sub">{t('teamHub.shelf.inAgents', { agents: item.agents.join(', ') })}</p>}
      {who && <p className="tpg-sub">{who}</p>}
      {!item.shareable && item.reason && (
        <p className="tpg-note" id={reasonId}>
          {item.reason}
        </p>
      )}
      <div className="tpg-actions">
        <button type="button" className="ck-btn ck-btn--secondary" disabled={!item.shareable} aria-describedby={!item.shareable ? reasonId : undefined} onClick={onSuggest}>
          {t('teamHub.shelf.suggestTo')}
        </button>
      </div>
    </li>
  );
}
