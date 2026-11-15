// The built-in tools (Node, Git, the phone link program) live in the install folder, or in a safe copy after a small update.
// If neither is whole, the app still runs and says so in one calm line with a Repair button. Repair downloads the full
// installer of this version (its signature is checked like any update) and runs it. Settings > About has the same button.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { plainUpdateError, tauriUpdateTransport, updateErrorCode, type ToolsStatus, type UpdateTransport } from '../../lib/app-update';
import { Btn } from '../settings/settings-ui';
import '../../styles/app-update.css';

export interface ToolsRepairState {
  /** Null until the app answered (or when this transport cannot say). */
  status: ToolsStatus | null;
  phase: 'idle' | 'repairing' | 'confirm' | 'error';
  error: string | null;
  /** The press on Repair. `confirmRunning` is the second press, after an agent was named. */
  repair(confirmRunning?: boolean): Promise<void>;
}

export function useToolsRepair(transport: UpdateTransport = tauriUpdateTransport): ToolsRepairState {
  const [status, setStatus] = useState<ToolsStatus | null>(null);
  const [phase, setPhase] = useState<ToolsRepairState['phase']>('idle');
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void transport.toolsStatus?.().then(
      (next) => {
        if (live.current) setStatus(next);
      },
      () => undefined,
    );
    return () => {
      live.current = false;
    };
  }, [transport]);

  const repair = useCallback(
    async (confirmRunning = false) => {
      if (!transport.repairTools) return;
      setError(null);
      setPhase('repairing');
      try {
        await transport.repairTools(confirmRunning);
      } catch (e) {
        if (!live.current) return;
        // An agent is working: the message names it; the second press restarts anyway.
        setError(plainUpdateError(e));
        setPhase(updateErrorCode(e) === 'UPDATE_RUNNING' ? 'confirm' : 'error');
      }
    },
    [transport],
  );

  return { status, phase, error, repair };
}

/** The Repair button with its words. Shared by the corner line and the Settings row. */
function RepairButton({ state, label, inNotice = false }: { state: ToolsRepairState; label?: string; inNotice?: boolean }) {
  const t = useT();
  const confirm = state.phase === 'confirm';
  const text = confirm ? t('tools.repairAnyway') : (label ?? t('tools.repair'));
  const press = () => void state.repair(confirm);
  if (inNotice) {
    return (
      <button type="button" className="app-update-btn" disabled={state.phase === 'repairing'} onClick={press}>
        {text}
      </button>
    );
  }
  return (
    <Btn disabled={state.phase === 'repairing'} onClick={press}>
      {text}
    </Btn>
  );
}

/** Shows nothing while the tools are fine. Mounted once, next to the update notice. */
export function ToolsMissingNotice({ transport = tauriUpdateTransport }: { transport?: UpdateTransport }) {
  const t = useT();
  const state = useToolsRepair(transport);
  if (!state.status || state.status.ok) return null;
  return (
    <div className="app-update-notice" role="status" data-phase="tools-missing" data-testid="tools-missing">
      <span>{t('tools.missing')}</span>
      {state.phase === 'repairing' ? <span>{t('tools.repairing')}</span> : <RepairButton state={state} inNotice />}
      {(state.phase === 'confirm' || state.phase === 'error') && state.error && <span className="app-update-detail">{state.error}</span>}
    </div>
  );
}

/** The line in Settings > About: always there, so a person can repair even when nothing looks wrong. */
export function ToolsRepairLine({ transport = tauriUpdateTransport }: { transport?: UpdateTransport }) {
  const t = useT();
  const state = useToolsRepair(transport);
  if (!transport.repairTools) return null;
  return (
    <div className="app-update-row" data-testid="tools-repair-line">
      <RepairButton state={state} label={t('tools.row.repair')} />
      {state.status?.ok && state.phase === 'idle' && <span className="app-update-detail">{t('tools.row.ok')}</span>}
      {state.status && !state.status.ok && state.phase === 'idle' && <span className="app-update-detail">{t('tools.missing')}</span>}
      {state.phase === 'repairing' && <span className="app-update-detail">{t('tools.repairing')}</span>}
      {(state.phase === 'confirm' || state.phase === 'error') && state.error && <span className="app-update-detail">{state.error}</span>}
    </div>
  );
}
