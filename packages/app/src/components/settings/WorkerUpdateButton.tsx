// One button that puts the person's Worker online (or brings it up to date) by itself: it shows the steps as they run,
// tries a failed step again, and after three failures hands the job to one of the person's agents. Nothing here shows a
// command; the output is behind "Details". The only manual part is the Cloudflare approval in the browser.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { requestAddAgentAction } from '../../lib/addAgentActions';
import {
  handoffTask,
  loadAgentView,
  pickHandoffAgent,
  runWorkerUpdate,
  tauriUpdateApi,
  type UpdateApi,
  type UpdateRun,
  type UpdateStep,
  type UpdateStepId,
} from '../../lib/workerUpdate';
import type { AcpLaneView } from '../../lib/acpChat';
import { Btn } from './settings-ui';

export type UpdateButtonLabel = 'wu.update' | 'wu.setup' | 'wu.setupLink';

type Handoff = { kind: 'none' } | { kind: 'busy' } | { kind: 'sent'; agent: string } | { kind: 'copy'; note: string; failed: boolean };

export function WorkerUpdateButton({
  address,
  label,
  onDone,
  api = tauriUpdateApi,
  loadAgents = loadAgentView,
  handOff = requestAddAgentAction,
  pauseMs,
}: {
  /** The Worker to update; none: a new one is set up. */
  address: string | null;
  label: UpdateButtonLabel;
  /** The run finished and the Worker answers with the latest features. `address` is the Worker's address. */
  onDone?: (address: string | null) => void;
  api?: UpdateApi;
  loadAgents?: () => Promise<AcpLaneView | null>;
  handOff?: (kind: 'chat', agentId: string, task: string) => void;
  /** The pause before a failed step runs again (tests give 0). */
  pauseMs?: number;
}) {
  const t = useT();
  const [steps, setSteps] = useState<UpdateStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState<UpdateRun | null>(null);
  const [handoff, setHandoff] = useState<Handoff>({ kind: 'none' });
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const labels = (): Record<UpdateStepId, string> => ({
    prepare: t('wu.step.prepare'),
    install: t('wu.step.install'),
    login: t('wu.step.login'),
    deploy: t('wu.step.deploy'),
    check: t('wu.step.check'),
  });

  const giveToAgent = async (run: UpdateRun) => {
    setHandoff({ kind: 'busy' });
    const task = handoffTask(run, labels());
    const agent = pickHandoffAgent(await loadAgents().catch(() => null));
    if (!alive.current) return;
    if (!agent) {
      setHandoff({ kind: 'copy', note: task, failed: false });
      return;
    }
    try {
      handOff('chat', agent.id, task);
      setHandoff({ kind: 'sent', agent: agent.label });
    } catch {
      setHandoff({ kind: 'copy', note: task, failed: true });
    }
  };

  const start = async () => {
    setRunning(true);
    setFinished(null);
    setHandoff({ kind: 'none' });
    const run = await runWorkerUpdate({
      address,
      api,
      pauseMs,
      isCancelled: () => !alive.current,
      onChange: (next) => alive.current && setSteps(next),
    });
    if (!alive.current) return;
    setRunning(false);
    setFinished(run);
    if (run.ok) onDone?.(run.address);
    else await giveToAgent(run);
  };

  const statusText = (s: UpdateStep): string =>
    s.status === 'retrying' ? t('wu.status.retrying', { n: String(s.tries) }) : t(`wu.status.${s.status}` as 'wu.status.waiting');
  const failedStep = finished?.steps.find((s) => s.id === finished.failed);
  const login = steps?.find((s) => s.id === 'login');

  return (
    <div data-testid="worker-update-button" className="stable-update">
      {!steps && <p>{t('wu.intro')}</p>}
      <div className="flex gap-2 items-center">
        <Btn primary data-testid="worker-update-go" disabled={running} onClick={() => void start()}>
          {t(finished && !finished.ok ? 'wu.retry' : label)}
        </Btn>
      </div>
      {steps && (
        <ol data-testid="worker-update-steps" className="stable-steps" aria-live="polite">
          {steps.map((s) => (
            <li key={s.id} data-step={s.id} data-status={s.status}>
              <strong>{t(`wu.step.${s.id}` as 'wu.step.prepare')}</strong> <span className="text-pm-muted">{statusText(s)}</span>
            </li>
          ))}
        </ol>
      )}
      {login && (login.status === 'running' || login.status === 'retrying') && <p data-testid="worker-update-login-note">{t('wu.loginNote')}</p>}
      {steps && steps.some((s) => s.output) && (
        <details data-testid="worker-update-details">
          <summary>{t('wu.details')}</summary>
          {steps
            .filter((s) => s.output)
            .map((s) => (
              <div key={s.id}>
                <small>{t(`wu.step.${s.id}` as 'wu.step.prepare')}</small>
                <pre className="font-mono break-all whitespace-pre-wrap">{s.output}</pre>
              </div>
            ))}
        </details>
      )}
      {finished?.ok && (
        <p data-testid="worker-update-done" role="status">
          {t('wu.done')}
        </p>
      )}
      {finished && !finished.ok && failedStep && (
        <div data-testid="worker-update-failed">
          <p role="alert">
            {t(`wu.step.${failedStep.id}` as 'wu.step.prepare')}: {t('wu.failedAll')}
          </p>
          {handoff.kind === 'busy' && <p>{t('wu.handing')}</p>}
          {handoff.kind === 'sent' && (
            <p data-testid="worker-update-handed" role="status">
              {t('wu.handedOver', { agent: handoff.agent })}
            </p>
          )}
          {handoff.kind === 'copy' && (
            <>
              <p data-testid="worker-update-copy-note">{handoff.failed ? t('wu.handFailed') : t('wu.noAgent')}</p>
              <Btn
                small
                onClick={() => {
                  void navigator.clipboard?.writeText(handoff.note).catch(() => undefined);
                  setCopied(true);
                }}
              >
                {copied ? t('wu.copied') : t('wu.copyNote')}
              </Btn>
            </>
          )}
        </div>
      )}
    </div>
  );
}
