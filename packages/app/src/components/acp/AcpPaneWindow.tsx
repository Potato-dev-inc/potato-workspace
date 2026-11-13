// The pop-out window of a chat session over ACP: the same pane the cockpit shows (header, conversation, cards, message
// box, result), alone in its own window. There is no terminal to attach, so the window never asks for one.
import { ErrorBoundary } from '../common/ErrorBoundary';
import { PaneView } from '../cockpit/PaneView';
import { useCockpit } from '../../hooks/useCockpit';
import { tauriAcpChatApi, type AcpChatApi } from '../../lib/acpChat';
import '../../styles/cockpit.css';
import '../../styles/chips.css';
import '../../styles/cockpit-acp.css';

export function AcpPaneWindow({ paneId, acp = tauriAcpChatApi }: { paneId: string; /** The chat-session calls. Replaceable in tests. */ acp?: AcpChatApi }) {
  const c = useCockpit();
  return (
    <div className="cockpit ck-single" data-theme={c.theme} data-testid="acp-pane-window">
      <main className="ck-main">
        <ErrorBoundary where="Pane" resetKeys={[paneId]}>
          <PaneView c={c} paneId={paneId} acp={acp} key={paneId} />
        </ErrorBoundary>
      </main>
    </div>
  );
}
