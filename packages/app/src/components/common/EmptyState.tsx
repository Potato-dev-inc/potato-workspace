// The one empty page: a title, one line, one button, then up to three quiet "or" rows. It sits a third of the way
// down the panel (not in the top-left corner) so every empty screen reads the same. Used by the Inbox, the welcome
// and the add-chat prompt. Panels with nothing to show are hidden, not explained: they do not use this.
import type { ReactNode } from 'react';

export interface EmptyAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface EmptyStateProps {
  title: string;
  /** One line under the title. */
  line?: ReactNode;
  /** The one button. */
  action?: EmptyAction | null;
  /** Up to three quiet "or" rows (more are dropped). */
  alternatives?: ReadonlyArray<EmptyAction>;
  /** The title is the page's h1 (a page with no other heading); otherwise an h2. */
  page?: boolean;
  /** The title is plain text, not a heading (inside a small menu). */
  plain?: boolean;
  /** Extra content under the buttons (a status line, a progress bar). */
  children?: ReactNode;
  className?: string;
}

export function EmptyState({ title, line, action, alternatives = [], page = false, plain = false, children, className }: EmptyStateProps) {
  const Heading = plain ? 'div' : page ? 'h1' : 'h2';
  return (
    <div className={`ck-empty${className ? ` ${className}` : ''}`} data-empty-state="">
      <Heading className="ck-empty-title">{title}</Heading>
      {line ? <p className="ck-empty-line">{line}</p> : null}
      {action ? (
        <button type="button" className="ck-btn ck-btn--primary" disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
      {alternatives.length > 0 ? (
        <ul className="ck-empty-or" aria-label="Other ways">
          {alternatives.slice(0, 3).map((a) => (
            <li key={a.label}>
              <button type="button" className="ck-empty-alt" disabled={a.disabled} onClick={a.onClick}>
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </div>
  );
}
