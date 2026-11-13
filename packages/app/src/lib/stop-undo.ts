// "Stop all agents" has no going back for the turn it interrupted, but the person can ask the agents to carry on:
// Undo on the bar sends each stopped agent the same plain "Continue where you left off." the Continue button sends.
import { t } from '../i18n';
import { CONTINUE_TEXT } from './acpChat';
import type { StopReport } from './loop-guard';
import { sendPaneMessage } from './paneOutbox';
import { showUndo } from './undo-bar';

/** Shows "Stopped 3 agents · Undo" for a report that stopped something. Nothing for an empty report. */
export function offerCarryOn(report: StopReport, send: (paneId: string, text: string) => Promise<unknown> = sendPaneMessage): void {
  const count = report.stopped.length;
  if (count === 0) return;
  showUndo({
    text: t('undo.stopped', { count }),
    failText: t('undo.failed'),
    undo: async () => {
      await Promise.all(report.stopped.map((s) => send(s.pane_id, CONTINUE_TEXT)));
    },
  });
}
