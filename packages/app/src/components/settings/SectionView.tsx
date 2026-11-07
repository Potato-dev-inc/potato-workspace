// Renders rows as grouped inset lists. Used by the panel for a section page and for search results,
// and by the section tests (which pass their own `envFor`).
import type { ReactNode } from 'react';
import { groupRows, splitByLevel, type RowDef, type SettingsEnv } from './model';
import './row-glow.css';

export interface RowChrome {
  /** Row ids whose "Saved" tick is showing. */
  saved?: ReadonlySet<string>;
  /** Row id -> error line. */
  errors?: Readonly<Record<string, string>>;
  /** The row a deep link just brought you to; it is marked for a moment. */
  target?: string;
}

/** One row: the row's own markup, plus the quiet "Saved" tick and its error line. */
export function RowShell({ row, env, chrome, where }: { row: RowDef; env: SettingsEnv; chrome?: RowChrome; where?: string }): ReactNode {
  const on = chrome?.saved?.has(row.id) ?? false;
  const error = chrome?.errors?.[row.id];
  return (
    <div className="st-rowwrap" data-row={row.id} data-target={chrome?.target === row.id ? 'true' : undefined}>
      {where && <p className="st-where">{`${row.label} · ${where}`}</p>}
      {row.render(env)}
      <span className={`st-saved${on ? ' is-on' : ''}`} role="status" aria-live="polite">
        {on ? 'Saved' : ''}
      </span>
      {error && (
        <p className="st-rowerr" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A section page: the basic rows, then one closed "Advanced" group (advanced rows), then the developer rows when
 * they are shown. `advancedOpen` is decided by the panel (remembered per section; a section with no basic rows
 * opens it by itself).
 */
export function LevelledRows({
  rows,
  envFor,
  chrome,
  advancedOpen,
  onToggleAdvanced,
  showDeveloper,
}: {
  rows: RowDef[];
  envFor: (row: RowDef) => SettingsEnv;
  chrome?: RowChrome;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  showDeveloper: boolean;
}) {
  const parts = splitByLevel(rows, showDeveloper);
  return (
    <>
      {parts.basic.length > 0 && <SectionRows rows={parts.basic} envFor={envFor} chrome={chrome} />}
      {parts.advanced.length > 0 && (
        <div className="st-advanced" data-advanced={advancedOpen ? 'open' : 'closed'}>
          <button type="button" className="st-adv-toggle" aria-expanded={advancedOpen} onClick={onToggleAdvanced}>
            <span>Advanced</span>
            <span className="st-adv-count">{parts.advanced.length}</span>
            <span aria-hidden="true">{advancedOpen ? '−' : '+'}</span>
          </button>
          {advancedOpen && <SectionRows rows={parts.advanced} envFor={envFor} chrome={chrome} />}
        </div>
      )}
      {parts.developer.length > 0 && <SectionRows rows={parts.developer} envFor={envFor} chrome={chrome} />}
    </>
  );
}

/** A section's rows as groups: headed lists first, then the destructive rows in their own last list. */
export function SectionRows({
  rows,
  envFor,
  chrome,
  sectionTitle,
}: {
  rows: RowDef[];
  envFor: (row: RowDef) => SettingsEnv;
  chrome?: RowChrome;
  /** Search results: a "Row name · Section" caption above each row. */
  sectionTitle?: string;
}) {
  return (
    <>
      {groupRows(rows).map((group, i) => (
        <section key={`${group.head ?? ''}-${i}`} className="st-group" data-danger={group.danger ? 'true' : undefined}>
          {group.head && <h2>{group.head}</h2>}
          <div className="st-list">
            {group.rows.map((row) => (
              <RowShell key={row.id} row={row} env={envFor(row)} chrome={chrome} where={sectionTitle} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
