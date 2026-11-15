// One section of the right panel: a small header button that folds it, and its rows. A folded section shows its
// one-line summary at the right of the label. No box around it; a hairline above (see styles/cockpit-rail.css).
import type { ReactNode } from 'react';
import { useRailClosed, type RailSectionId } from './railFold';

export function RailSection({
  id,
  title,
  summary,
  testId,
  children,
}: {
  id: RailSectionId;
  title: string;
  /** What shows at the right of the label while the section is folded. */
  summary?: ReactNode;
  testId?: string;
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
      </h3>
      {!closed && <div className="rp-rows">{children}</div>}
    </section>
  );
}
