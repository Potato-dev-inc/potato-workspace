// One button that puts the person's Worker online (or brings it up to date) by itself: it shows the steps as they run,
// tries a failed step again, and after three failures offers one thing to do — hand the job to one of the person's
// agents. Nothing here shows a command; the output is behind "Details". The only manual part is the Cloudflare
// approval in the browser. The picture is the shared SetupStepBlock, so a failure looks the same as everywhere else.
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
  type UpdateStepId,
} from '../../lib/workerUpdate';
import type { AcpLaneView } from '../../lib/acpChat';
import { SetupStepBlock, type SetupStep } from '../common/SetupStepBlock';
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
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
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

  /** "Let Claude fix it": the same chat hand-off Settings > Agents uses, with the goal and the printed error. */
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
    setCopied(false);
    const run = await runWorkerUpdate({
      address,
      api,
      pauseMs,
      isCancelled: () => !alive.current,
      onChange: (next) =>
        alive.current &&
        setSteps(
          next.map((s) => ({
            id: s.id,
            label: t(`wu.step.${s.id}` as 'wu.step.prepare'),
            status: s.status,
            tries: s.tries,
            // The one manual part speaks only while its own step runs; later steps say nothing until then.
            note: s.id === 'login' && (s.status === 'running' || s.status === 'retrying') ? t('wu.loginNote') : undefined,
            output: s.output,
          })),
        ),
    });
    if (!alive.current) return;
    setRunning(false);
    setFinished(run);
    if (run.ok) onDone?.(run.address);
  };

  const failed = finished && !finished.ok ? finished.failed : null;

  return (
    <div data-testid="worker-update-button" className="stable-update">
      {!steps && <p>{t('wu.intro')}</p>}
      <div className="flex gap-2 items-center">
        <Btn primary data-testid="worker-update-go" disabled={running} onClick={() => void start()}>
          {running ? t('setupStep.status.running') : t(label)}
        </Btn>
      </div>
      {steps && (
        <SetupStepBlock
          testId="worker-update"
          steps={steps}
          failedId={failed}
          onFix={finished && !finished.ok ? () => void giveToAgent(finished) : undefined}
          fixing={handoff.kind === 'busy'}
          handed={handoff.kind === 'sent' ? t('wu.handedOver', { agent: handoff.agent }) : null}
          onRetry={finished && !finished.ok ? () => void start() : undefined}
          done={finished?.ok ? t('wu.done') : null}
        >
          {handoff.kind === 'copy' && (
            <div data-testid="worker-update-copy-note">
              <p>{handoff.failed ? t('wu.handFailed') : t('wu.noAgent')}</p>
              <Btn
                small
                onClick={() => {
                  void navigator.clipboard?.writeText(handoff.note).catch(() => undefined);
                  setCopied(true);
                }}
              >
                {copied ? t('wu.copied') : t('wu.copyNote')}
              </Btn>
            </div>
          )}
        </SetupStepBlock>
      )}
    </div>
  );
}
