// The phone's terminal pane. The xterm view (about 360 KB of code) loads on the first render of a terminal, not with
// the phone's first screen: the view file holds it, and this file only wraps it in a lazy import.
import { lazy, Suspense, useMemo } from 'react';
import type { TerminalTransport } from '../hooks/useTerminalSession';
import type { BridgePaneTerminalProps } from './BridgePaneTerminalView';

const TerminalView = lazy(() => import('./BridgePaneTerminalView').then((m) => ({ default: m.BridgePaneTerminal })));

export function BridgePaneTerminal(props: BridgePaneTerminalProps) {
  return (
    <Suspense fallback={<div className="flex-1 min-h-0 overflow-hidden" />}>
      <TerminalView {...props} />
    </Suspense>
  );
}

export function useBridgePaneTransport(
  makeTransport: (paneId: string) => TerminalTransport,
  paneId: string,
): TerminalTransport {
  return useMemo(() => makeTransport(paneId), [makeTransport, paneId]);
}
