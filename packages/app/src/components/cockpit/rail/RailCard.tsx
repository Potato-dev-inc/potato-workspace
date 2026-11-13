// One section of the session rail (plain: a small label, rows, a hairline between sections): a small heading (with an optional note on the right) and the card's lines.
import type { ReactNode } from 'react';

export function RailCard({
  title,
  note,
  testId,
  bare,
  children,
}: {
  title: string;
  note?: ReactNode;
  testId?: string;
  /** No visible heading (the rows carry their own small labels); the section is still named for screen readers. */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="ck-rail-card" aria-label={title} data-testid={testId}>
      {!bare && (
        <h3 className="ck-rail-h">
          <span>{title}</span>
          {note != null && <span className="ck-rail-note">{note}</span>}
        </h3>
      )}
      {children}
    </section>
  );
}
