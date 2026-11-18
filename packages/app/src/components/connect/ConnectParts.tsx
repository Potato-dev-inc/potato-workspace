// Small pieces every Connect tab shares: the scope for the reused Settings screens, the one status line and the one main button.
import type { ReactNode } from 'react';
import type { ConnectTab } from '../../lib/openConnect';

/** The reused Settings screens carry their own `.settings`-scoped styles: this gives them that scope without the Settings window around them. */
export function Embed({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="settings settings--embed cn-embed" data-testid={testId}>
      {children}
    </div>
  );
}

/** What is connected, in one line, with a dot that is lit when something is. */
export function Status({ tab, line, on }: { tab: ConnectTab; line: string; on?: boolean }) {
  return (
    <p className="cn-status" data-testid={`connect-status-${tab}`} data-on={on ? 'true' : 'false'}>
      <span className="cn-dot" aria-hidden="true" />
      {line}
    </p>
  );
}

/** The one main button of a tab. */
export function Main({ tab, children, onClick, expanded }: { tab: ConnectTab; children: ReactNode; onClick: () => void; expanded?: boolean }) {
  return (
    <button type="button" className="ck-btn ck-btn--primary cn-main" data-testid={`connect-main-${tab}`} aria-expanded={expanded} onClick={onClick}>
      {children}
    </button>
  );
}
