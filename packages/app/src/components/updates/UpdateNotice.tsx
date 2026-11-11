// A quiet notice in a corner: "Update available: 1.0.3" with an Update button. Nothing installs until the button is pressed.
// The file downloads first ("Downloading 42%"); if an agent is working then, the notice says which ones stop and asks:
// Restart now, or When agents finish. A failed update says why in a plain sentence and the app keeps running. If the agents
// were already stopped, it says so and offers to reopen the chats.
import type { AppUpdateState } from './useAppUpdate';
import { runningJobWarning } from '../../lib/app-update';
import '../../styles/app-update.css';

export function UpdateNoticeView({ state }: { state: AppUpdateState }) {
  const { phase, offer } = state;
  if (phase === 'idle' || phase === 'none' || phase === 'checking') return null;
  const busy = state.busyAgents.length > 0;
  return (
    <div className="app-update-notice" role="status" data-phase={phase}>
      {phase === 'available' && offer && (
        <>
          <span>Update available: {offer.version}</span>
          <button type="button" className="app-update-btn" onClick={() => void state.update()}>
            Update
          </button>
        </>
      )}
      {phase === 'downloading' && (
        <>
          <span>{state.percent === null ? 'Downloading…' : `Downloading ${state.percent}%`}</span>
          {state.percent !== null && <progress className="app-update-bar" max={100} value={state.percent} aria-label="Download progress" />}
        </>
      )}
      {phase === 'ready' && (
        <>
          <span>{busy ? `Ready. ${runningJobWarning(state.busyAgents, state.busy)}` : 'Ready. Restart to finish the update.'}</span>
          <button type="button" className="app-update-btn" onClick={() => void state.restartNow()}>
            Restart now
          </button>
          {busy && (
            <button type="button" className="app-update-btn app-update-btn--quiet" onClick={state.restartWhenIdle}>
              When agents finish
            </button>
          )}
        </>
      )}
      {phase === 'waiting' && (
        <>
          <span>Ready. Waiting for your agents to finish. This tells you when it is safe to restart.</span>
          <button type="button" className="app-update-btn" onClick={() => void state.restartNow()}>
            Restart now
          </button>
        </>
      )}
      {phase === 'installing' && <span>Installing the update. Potato Workspace will close. Open it again when the installer is done.</span>}
      {phase === 'stopped' && (
        <>
          <span>{state.reopened ? 'Chats reopened. Terminal agents were not reopened.' : `${state.error ?? 'Agents were stopped.'} Reopen them to carry on.`}</span>
          {!state.reopened && (
            <button type="button" className="app-update-btn" onClick={() => void state.reopenChats()}>
              Reopen chats
            </button>
          )}
          {offer && (
            <button type="button" className="app-update-btn app-update-btn--quiet" onClick={() => void state.update()}>
              Try again
            </button>
          )}
        </>
      )}
      {phase === 'error' && (
        <>
          <span>{state.error}</span>
          {offer && (
            <button type="button" className="app-update-btn" onClick={() => void state.update()}>
              Try again
            </button>
          )}
        </>
      )}
    </div>
  );
}
