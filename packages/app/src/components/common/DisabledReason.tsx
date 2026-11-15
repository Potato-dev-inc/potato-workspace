// The visible reason under a greyed control. A disabled control used to say why only in a hover tooltip, which a
// touch screen never shows and a keyboard user never sees. Put this line next to (or under) the control, and only
// when the reason is known. It renders nothing when there is no reason, so callers can pass the value straight in.
import type { ReactNode } from 'react';
import '../../styles/disabled-reason.css';

export interface DisabledReasonProps {
  /** The plain sentence that says why the control is off. Empty or null draws nothing. */
  reason: ReactNode | null | undefined;
  id?: string;
  /** `span` when the line sits inside a button or a menu row (a `p` cannot go inside a button). */
  as?: 'p' | 'span';
  className?: string;
}

export function DisabledReason({ reason, id, as = 'p', className }: DisabledReasonProps) {
  if (reason === null || reason === undefined || reason === false || reason === '') return null;
  const Tag = as;
  return (
    <Tag id={id} className={`dis-reason${className ? ` ${className}` : ''}`} data-disabled-reason="">
      {reason}
    </Tag>
  );
}
