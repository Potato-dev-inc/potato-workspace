// The agent row of the sidebar (the clickable part): mark, title, one sub line, the helper count, and the one thing on the right
// (needs you, error, or the time it has worked). One component for BOTH This PC and another PC's section, so the rows are identical;
// everything around it (hover buttons, menus, drag, peek) stays with the caller.
import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { RowMark } from './RowMark';

export interface AgentRowButtonProps {
  id: string;
  status: string;
  agentType: string;
  agentLabel?: string;
  title: string;
  /** The tooltip of the text block (the full line). */
  tip?: string;
  /** The tooltip of the whole row (the last turn's sentence). */
  rowTip?: string;
  /** The sub line, or any node that replaces it (a live "doing" line). */
  sub: ReactNode;
  active: boolean;
  asking: boolean;
  /** Mark of a spin-off nested under its agent ("↳"). */
  nested?: boolean;
  /** Helpers counted on the row (when the tree is folded away). */
  helperCount?: number;
  /** "3m", while it works. */
  elapsed?: string;
  /** Extra marks between the text and the right side (preview globe, pin). */
  extra?: ReactNode;
  /** Under the sub line (the plan line). */
  below?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  /** Spread on the button: drag source, context menu. */
  buttonProps?: Record<string, unknown>;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function AgentRowButton({ id, status, agentType, agentLabel, title, tip, rowTip, sub, active, asking, nested, helperCount = 0, elapsed, extra, below, disabled, onClick, buttonProps, onContextMenu }: AgentRowButtonProps) {
  const t = useT();
  const pill = asking && status !== 'error';
  const broken = status === 'error';
  const working = status === 'running' && !asking;
  const calm = !asking && !broken && !working;
  return (
    <button
      type="button"
      data-pane-row={id}
      disabled={disabled}
      className={`ck-row ck-row--slim${active ? ' is-active' : ''}${asking ? ' is-needs' : ''}${broken ? ' is-error' : ''}${calm ? (status === 'idle' ? ' is-idle' : ' is-ended') : ''}`}
      onClick={onClick}
      {...buttonProps}
      onContextMenu={onContextMenu}
      title={rowTip}
      aria-current={active ? 'true' : undefined}
      aria-label={pill ? t('sidebar.rowNeedsYou', { name: title }) : undefined}
    >
      <span className="ck-row-glyph">
        <RowMark status={status} asking={pill} agentId={agentType} agentName={agentLabel} />
      </span>
      <span className="ck-row-main" title={tip}>
        {nested && (
          <span className="ck-row-nest" data-testid="row-spinoff-mark" aria-hidden="true">
            ↳
          </span>
        )}
        <span className="ck-row-title">{title}</span>
        {sub}
        {below}
      </span>
      {extra}
      {helperCount > 0 && (
        <span className="ck-row-helpers" data-testid="row-helper-count" title={t('sidebar.helperCount', { count: helperCount })} role="img" aria-label={t('sidebar.helperCount', { count: helperCount })}>
          {helperCount}
        </span>
      )}
      {/* The right side says one thing: the chip when it needs you or is broken, the time while it works, else nothing. */}
      {pill ? <span className="ck-row-pill">{t('sidebar.needsYou')}</span> : broken ? <span className="ck-row-pill ck-row-pill--error">{t('sidebar.error')}</span> : working ? <span className="ck-row-time">{elapsed ?? ''}</span> : null}
    </button>
  );
}
