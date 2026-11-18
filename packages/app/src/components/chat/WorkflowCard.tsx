// One compact row in a chat for a message the app wrote on the person's behalf: "Using workflow: <name>" at the top of
// a chat that started from a workflow, "Marked up: <page> · 2 marks" for a mark-up sent from the agent browser. Closed,
// it is the size of a minion row. Open, it shows the whole text the agent was told (read only, scrolls, plain text), so
// nothing is hidden. The text can come from a web page, so it is never drawn as HTML or markdown and has no links.
import { useState } from 'react';
import { useT } from '../../i18n';
import type { WorkflowSplit } from '../../lib/workflowCard';
import type { MarkupSplit } from '../../lib/markupCard';
import { holdsQuery, useFindQuery } from './chatFind';

/** Three linked dots: a flow. Not the minion cube or the spin-off branch. */
function FlowGlyph() {
  return (
    <svg className="ck-chat-wf-glyph" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="3.5" cy="8" r="1.6" />
      <circle cx="12.5" cy="4" r="1.6" />
      <circle cx="12.5" cy="12" r="1.6" />
      <path d="M5 7.4 11 4.6M5 8.6l6 2.8" />
    </svg>
  );
}

/** A cursor arrow with a small mark beside it: "pointed at something on a page". */
function MarkGlyph() {
  return (
    <svg className="ck-chat-wf-glyph" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 2.5 9.5 8.2 6.3 8.8 8 12.2 6.6 12.9 4.9 9.5 3 11.2Z" />
      <path d="M11 2.5h2.5V5M13.5 2.5 11.6 4.4" />
    </svg>
  );
}

export interface ContextCardProps {
  kind: 'workflow' | 'markup';
  label: string;
  /** Kept whole at the end of the row when a long label is cut ("· 2 marks"). */
  tail?: string;
  /** The read-only text shown when the card is open. */
  details: string;
  showTitle: string;
  hideTitle: string;
  defaultOpen?: boolean;
}

export function ContextCard({ kind, label, tail, details, showTitle, hideTitle, defaultOpen = false }: ContextCardProps) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  // A search that matches the text opens the card by itself, so the match can be seen.
  const found = holdsQuery(`${label}\n${details}`, useFindQuery());
  const open = toggled ?? (defaultOpen || found);
  const id = kind === 'workflow' ? 'workflow-card' : 'markup-card';
  return (
    <div className="ck-chat-wf w-full self-stretch" data-testid={id}>
      <button
        type="button"
        aria-expanded={open}
        title={open ? hideTitle : showTitle}
        onClick={() => setToggled(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-0.5 text-left hover:bg-pm-raised ck-chat-tool ck-chat-helper-row ck-chat-wf-row"
      >
        {kind === 'workflow' ? <FlowGlyph /> : <MarkGlyph />}
        <span className="flex min-w-0 flex-1 items-baseline">
          <span className="min-w-0 truncate text-pm-text ck-chat-helper-text" title={label}>
            <bdi>{label}</bdi>
          </span>
          {tail && <span className="shrink-0 whitespace-pre text-pm-muted ck-chat-helper-text">{` · ${tail}`}</span>}
        </span>
        <svg className="shrink-0 text-pm-muted" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="ck-chat-wf-text mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-pm-raised px-2 py-1 text-xs text-pm-text" data-testid={`${id}-text`} tabIndex={0}>
          {details}
        </div>
      )}
    </div>
  );
}

export function WorkflowCard({ split, defaultOpen = false }: { split: WorkflowSplit; defaultOpen?: boolean }) {
  const t = useT();
  return <ContextCard kind="workflow" label={t('workflowCard.using', { name: split.name })} details={split.brief} showTitle={t('workflowCard.show')} hideTitle={t('workflowCard.hide')} defaultOpen={defaultOpen} />;
}

export function MarkupCard({ split, defaultOpen = false }: { split: MarkupSplit; defaultOpen?: boolean }) {
  const t = useT();
  const count = split.marks === 1 ? t('markupCard.one') : t('markupCard.many', { n: split.marks });
  const page = split.page.trim() === '' ? t('markupCard.thisPage') : split.page;
  return <ContextCard kind="markup" label={t('markupCard.label', { page })} tail={count} details={split.details} showTitle={t('markupCard.show')} hideTitle={t('workflowCard.hide')} defaultOpen={defaultOpen} />;
}
