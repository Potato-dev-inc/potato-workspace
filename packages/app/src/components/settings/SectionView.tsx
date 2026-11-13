// Renders rows as grouped inset lists. Used by the panel for a section page and for search results,
// and by the section tests (which pass their own `envFor`).
import type { KeyboardEvent, ReactNode } from 'react';
import { isChanged } from './changes';
import { groupRows, rowLevel, splitByLevel, type RowDef, type SettingsEnv } from './model';
import { PANEL_ROWS } from './search';
import { Btn } from './settings-ui';
import './row-glow.css';

export interface RowChrome {
  /** Row ids whose "Saved" tick is showing. */
  saved?: ReadonlySet<string>;
  /** Row id -> error line. */
  errors?: Readonly<Record<string, string>>;
  /** The row a deep link just brought you to; it is marked for a moment. */
  target?: string;
  /** Search results: the hit Up/Down has reached; Enter opens it. */
  active?: string;
  /** "Reset" on a changed row: puts every key of the row back to its default in one patch. Absent: no Reset button. */
  onReset?: (row: RowDef) => void;
}

/**
 * One row: the row's own markup, its preview, the quiet "Saved" tick and its error line. A row whose saved keys
 * differ from the default also shows a grey dot before its label and a "Reset" button (on hover or focus).
 */
export function RowShell({ row, env, chrome, tag }: { row: RowDef; env: SettingsEnv; chrome?: RowChrome; tag?: boolean }): ReactNode {
  const on = chrome?.saved?.has(row.id) ?? false;
  const error = chrome?.errors?.[row.id];
  const changed = Boolean(env.settings) && isChanged(row, env.settings);
  const preview = row.preview?.(env);
  return (
    <div
      className="st-rowwrap"
      data-row={row.id}
      data-changed={changed ? 'true' : undefined}
      tabIndex={-1}
      data-target={chrome?.target === row.id ? 'true' : undefined}
      data-active={chrome?.active === row.id ? 'true' : undefined}
    >
      {changed && <span className="st-dot" role="img" title="Changed from the default" aria-label="Changed from the default" />}
      {tag && rowLevel(row) !== 'basic' && (
        <span className="st-level-tag" data-level={rowLevel(row)}>
          {rowLevel(row) === 'developer' ? 'Developer' : 'Advanced'}
        </span>
      )}
      {row.render(env)}
      {preview}
      {changed && chrome?.onReset && (
        <button type="button" className="st-reset" aria-label={`Reset ${row.label}`} onClick={() => chrome.onReset?.(row)}>
          Reset
        </button>
      )}
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
  flat = false,
}: {
  rows: RowDef[];
  envFor: (row: RowDef) => SettingsEnv;
  chrome?: RowChrome;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  showDeveloper: boolean;
  /** One list, no "Advanced" fold (the Shortcuts page: every row is a shortcut). */
  flat?: boolean;
}) {
  const parts = splitByLevel(rows, showDeveloper);
  if (flat) return <SectionRows rows={[...parts.basic, ...parts.advanced, ...parts.developer]} envFor={envFor} chrome={chrome} />;
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
  pathPrefix,
  onGoToRow,
  dangerHead,
}: {
  rows: RowDef[];
  envFor: (row: RowDef) => SettingsEnv;
  chrome?: RowChrome;
  /** Search results: the page title. Each group's heading then reads "Page › Group" and rows carry their level tag. */
  pathPrefix?: string;
  /** Search results: a panel row (a list, a check) is one line with a button that goes to the row. */
  onGoToRow?: (rowId: string) => void;
  /** The heading over the destructive list, when the page wants one. */
  dangerHead?: string;
}) {
  return (
    <>
      {groupRows(rows).map((group, i) => (
        <section key={`${group.head ?? ''}-${i}`} className="st-group" data-danger={group.danger ? 'true' : undefined}>
          {(group.head || pathPrefix || (group.danger && dangerHead)) && (
            <h2 className={pathPrefix ? 'st-path' : undefined}>{pathPrefix ? (group.head ? `${pathPrefix} › ${group.head}` : pathPrefix) : (group.head ?? dangerHead)}</h2>
          )}
          <div className="st-list">
            {group.rows.map((row) =>
              pathPrefix && onGoToRow && PANEL_ROWS.has(row.id) ? (
                <div key={row.id} className="st-rowwrap" data-row={row.id} data-active={chrome?.active === row.id ? 'true' : undefined}>
                  <div className="st-row st-linehit">
                    <div className="st-label">
                      <span>{row.label}</span>
                    </div>
                    <Btn small aria-label={`Go to ${row.label}`} onClick={() => onGoToRow(row.id)}>
                      Go to row
                    </Btn>
                  </div>
                </div>
              ) : (
                <RowShell key={row.id} row={row} env={envFor(row)} chrome={chrome} tag={Boolean(pathPrefix)} />
              ),
            )}
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * The Advanced page: its groups are closed disclosure headers with a row count (no "Advanced" fold). The groups
 * in `closed` fold; any other group (Developer, the danger list) is an open list. `isOpen` is decided by the panel
 * (remembered per group). A group with no row to show is not drawn.
 */
const ALWAYS_DRAWN = ['Connections to other tools', 'Models', 'Early features (Labs)', 'App and files'];

export function ClosedGroups({
  rows,
  closed,
  envFor,
  chrome,
  isOpen,
  onToggle,
  showDeveloper,
}: {
  rows: RowDef[];
  closed: string[];
  envFor: (row: RowDef) => SettingsEnv;
  chrome?: RowChrome;
  isOpen: (group: string) => boolean;
  onToggle: (group: string) => void;
  showDeveloper: boolean;
}) {
  const shown = rows.filter((r) => showDeveloper || rowLevel(r) !== 'developer');
  // The named groups are always drawn (closed, with the count of what they hold), so the page never reads as "the uninstall page".
  const folded = closed.map((head) => ({ head, rows: shown.filter((r) => !r.danger && r.group === head) })).filter((g) => g.rows.length > 0 || ALWAYS_DRAWN.includes(g.head));
  const rest = shown.filter((r) => r.danger || !closed.includes(r.group ?? ''));
  return (
    <>
      {folded.map(({ head, rows: groupRowsList }) => {
        const open = isOpen(head);
        return (
          <section key={head} className="st-group st-closed-group" data-group={head} data-open={open ? 'true' : 'false'}>
            {/* One card: the header is its first row. */}
            <div className="st-list">
              <button type="button" className="st-adv-toggle" aria-expanded={open} onClick={() => onToggle(head)}>
                <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                <span>{head}</span>
                <span className="st-adv-count">{groupRowsList.length}</span>
              </button>
              {open && groupRowsList.map((row) => <RowShell key={row.id} row={row} env={envFor(row)} chrome={chrome} />)}
            </div>
          </section>
        );
      })}
      {rest.length > 0 && <SectionRows rows={rest} envFor={envFor} chrome={chrome} dangerHead="Remove" />}
    </>
  );
}

const TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"]';
const FIRST_CONTROL = '[role="switch"], select, input:not([type="hidden"]), textarea, button:not(.st-reset):not(.st-adv-toggle):not(:disabled)';

/**
 * Keyboard for a page of rows (put it on the element that holds them): Up and Down move between rows (a row's
 * first control takes focus), and Enter flips the switch of the focused row. Text fields and popups keep their own
 * arrow keys, and Space already flips a focused switch.
 */
export function onRowKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const wrap = target?.closest<HTMLElement>('.st-rowwrap');
  if (!target || !wrap) return;
  if (event.key === 'Enter') {
    const flip = target.closest<HTMLButtonElement>('[role="switch"]') ?? (target === wrap ? wrap.querySelector<HTMLButtonElement>('[role="switch"]') : null);
    if (flip && !flip.disabled) {
      event.preventDefault();
      flip.click();
    }
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (target.matches(TEXT_FIELD)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('.st-rowwrap')];
  const next = rows[rows.indexOf(wrap) + (event.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  event.preventDefault();
  (next.querySelector<HTMLElement>(FIRST_CONTROL) ?? next).focus();
}
