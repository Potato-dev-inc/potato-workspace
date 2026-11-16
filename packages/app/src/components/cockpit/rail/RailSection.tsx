// One section of the right panel: a small header button that folds it, and its rows. A folded section shows its
// one-line summary at the right of the label. No box around it; a hairline above (see styles/cockpit-rail.css).
import type { ReactNode } from 'react';
import { useRailClosed, type RailSectionId } from './railFold';

export function RailSection({
  id,
  title,
  summary,
  testId,
  action,
  children,
}: {
  id: RailSectionId;
  title: string;
  /** What shows at the right of the label while the section is folded. */
  summary?: ReactNode;
  testId?: string;
  /** A small button at the right of the heading while the section is open (it opens the section's own page). */
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  const [closed, setClosed] = useRailClosed(id);
  return (
    <section className={`rp-sec${closed ? ' is-closed' : ''}`} aria-label={title} data-testid={testId ?? `rail-${id}`} data-sec={id}>
      <h3 className="rp-sec-h">
        <button type="button" aria-expanded={!closed} onClick={() => setClosed(!closed)}>
          <span>{title}</span>
          <svg className="rp-chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 6 4 4 4-4" />
          </svg>
          {closed && summary != null && <span className="rp-sum">{summary}</span>}
        </button>
        {!closed && action && (
          <button type="button" className="rp-sec-open" aria-label={action.label} title={action.label} onClick={action.onClick}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.5 3H13v3.5M13 3 8.5 7.5M6.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.5" />
            </svg>
          </button>
        )}
      </h3>
      {!closed && <div className="rp-rows">{children}</div>}
    </section>
  );
}
