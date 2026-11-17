// "Set up my relay": ONE button that runs the whole guided setup by itself. The person presses it once, signs in to
// Cloudflare in the browser that opens, and waits. The app prepares the files, installs the tool, deploys, reads the
// new address from the deploy output, links this PC with a key it makes and keeps itself, and checks that it works.
// It reuses the step commands and runner of "Set up one fixed address" (lib/workerUpdate.ts) and the same tunnel save
// as the old sheet; it only chains them. The old step-by-step sheet (StableLinkSheet) stays reachable under Advanced.
// Default texts use no technical words; the tool's output is only inside "Show details", and is scrubbed first.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDismissable } from '../../hooks/useDismissable';
import { useT } from '../../i18n';
import { classifyProblem, PROBLEM_FIX, relayAddress, scrubDetails, stopsRetrying, type RelayProblem } from '../../lib/relaySetup';
import { errorSentence } from '../../lib/sayError';
import { tauri } from '../../lib/tauri';
import type { TunnelStatus } from '../../lib/tauri-types';
import { FRESH_STEPS, runWorkerUpdate, tauriUpdateApi, UPDATE_STEPS, type UpdateApi, type UpdateStep, type UpdateStepId } from '../../lib/workerUpdate';
import { SecretValue } from '../settings/SecretValue';
import type { TunnelApi } from '../settings/TunnelSection';
import '../../styles/setup-step.css';
import '../../styles/relay-setup.css';

type RowId = UpdateStepId | 'link';
interface Row {
  id: RowId;
  status: UpdateStep['status'];
  tries: number;
  output: string;
}
type Phase = 'running' | 'problem' | 'done';

const CLOUDFLARE = 'https://dash.cloudflare.com/';
/** How long this PC may take to link before the setup says "not linked yet". */
const LINK_WAIT_MS = 45_000;
/** ONE setup runs at a time in the whole app: a new sheet waits for the earlier run's tool to stop first. */
let inFlight: Promise<unknown> | null = null;
const hostName = (address: string) => address.replace(/^https:\/\//, '').split('.')[0] ?? '';
const rowsFor = (fresh: boolean): Row[] =>
  [...(fresh ? FRESH_STEPS : UPDATE_STEPS), 'link' as const].map((id) => ({
    id,
    status: 'waiting',
    tries: 0,
    output: '',
  }));

/** The prominent card: where there is no relay yet, this is the one thing to press. Same flow from every place. */
export function RelaySetupCard({ onStart, lead, label }: { onStart: () => void; lead?: string; label?: string }) {
  const t = useT();
  return (
    <div className="rs-card" data-testid="relay-card">
      {lead && <p className="rs-card-lead">{lead}</p>}
      <button type="button" className="ss-btn ss-btn--primary rs-big" data-testid="relay-set-up" onClick={onStart}>
        {label ?? t('relaySetup.set')}
      </button>
      <p className="rs-card-sub">{t('relaySetup.sub')}</p>
    </div>
  );
}

export function RelaySetupSheet({
  api,
  onClose,
  onStatus,
  updateApi = tauriUpdateApi,
  openExternal = (url: string) => tauri.openExternalUrl(url),
  pauseMs,
  linkPollMs,
}: {
  api: TunnelApi;
  /** `address` is the relay when the setup finished, else null. */
  onClose: (address: string | null) => void;
  /** The saved setting, once the setup is over (never in the middle of it, so no screen behind is rebuilt under the sheet). */
  onStatus?: (status: TunnelStatus) => void;
  updateApi?: UpdateApi;
  openExternal?: (url: string) => Promise<unknown> | void;
  pauseMs?: number;
  linkPollMs?: number;
}) {
  const t = useT();
  // The wait between reads follows the step runner's pause (tests give 0).
  const pollMs = linkPollMs ?? pauseMs ?? updateApi.pauseMs ?? 1500;
  const [rows, setRows] = useState<Row[]>(rowsFor(false));
  const [phase, setPhase] = useState<Phase>('running');
  const phaseRef = useRef<Phase>('running');
  phaseRef.current = phase;
  const cancelSent = useRef(false);
  const updateApiRef = useRef(updateApi);
  updateApiRef.current = updateApi;
  const [problem, setProblem] = useState<RelayProblem | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [linkedHost, setLinkedHost] = useState('');
  const sheetRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const cancelled = useRef(false);
  const started = useRef(false);
  const latest = useRef<TunnelStatus | null>(null);
  const saved = useRef<string | null>(null);
  const runId = useRef(0);

  const patchRow = useCallback((id: RowId, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))), []);
  const fail = useCallback((p: RelayProblem) => {
    setProblem(p);
    setPhase('problem');
  }, []);
  const stale = (mine: number) => cancelled.current || !alive.current || mine !== runId.current;

  /** Reads the saved setting until this PC is linked. `mismatch` when the old relay holds another key. */
  const waitForLink = useCallback(
    async (address: string, mine: number) => {
      patchRow('link', { status: 'running', tries: 1 });
      const tries = pollMs > 0 ? Math.ceil(LINK_WAIT_MS / pollMs) : 12;
      for (let i = 0; i < tries; i++) {
        let s: TunnelStatus | null = latest.current;
        if (i > 0) {
          if (pollMs > 0) await new Promise((r) => setTimeout(r, pollMs));
          s = await Promise.resolve()
            .then(() => api.getStatus())
            .catch(() => null);
        }
        if (stale(mine)) return;
        if (s) latest.current = s;
        if (s?.stable?.link === 'linked') {
          patchRow('link', { status: 'done' });
          setLinkedHost(address.replace(/^https:\/\//, ''));
          setPhase('done');
          return;
        }
        if (s?.stable?.link === 'failed' && s.stable.secret_mismatch) {
          patchRow('link', { status: 'failed', output: s.stable.error ?? '' });
          fail('mismatch');
          return;
        }
      }
      patchRow('link', { status: 'failed' });
      fail('linking');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, fail, pollMs, patchRow],
  );

  /** The whole setup. `old`: the relay that is in the way (start fresh), else a new relay is made. */
  const start = useCallback(
    async (old: string | null) => {
      const mine = ++runId.current;
      cancelled.current = false;
      setAsking(false);
      setProblem(null);
      setPhase('running');
      setSecret(null);
      setRows(rowsFor(old !== null));
      // An earlier run (cancelled a moment ago) may still be stopping its tool: wait for it, never overlap.
      while (inFlight && !stale(mine)) await inFlight.catch(() => undefined);
      if (stale(mine)) return;
      const job = runWorkerUpdate({
        address: old,
        api: updateApi,
        pauseMs,
        fresh: old !== null,
        noRetry: stopsRetrying,
        isCancelled: () => stale(mine),
        onChange: (steps) => !stale(mine) && setRows((rs) => rs.map((r) => steps.find((s) => s.id === r.id) ?? r)),
      });
      inFlight = job;
      const run = await job.finally(() => {
        if (inFlight === job) inFlight = null;
      });
      if (stale(mine)) return;
      if (!run.ok || !run.address) {
        const step = run.steps.find((s) => s.id === run.failed);
        fail(classifyProblem(run.failed ?? 'deploy', step?.output ?? ''));
        return;
      }
      // Only this relay's own address is ever saved and linked: exactly https://<name>.<you>.workers.dev, and for "start fresh" the same name.
      const address = relayAddress(run.address, old !== null ? hostName(old) : undefined);
      if (!address) {
        patchRow('deploy', { status: 'failed', output: 'The tool printed an address that is not your relay, so nothing was saved.' });
        fail('other');
        return;
      }
      saved.current = address;
      patchRow('link', { status: 'running', tries: 1 });
      try {
        // A new relay: the app makes the key and keeps it itself. After "start fresh" the old key is replaced.
        const next = await api.save(
          old !== null
            ? {
                mode: 'stable',
                worker_url: address,
                secret_action: 'regenerate',
                confirm_strand: true,
              }
            : {
                mode: 'stable',
                worker_url: address,
                secret: null,
                secret_action: 'keep',
              },
        );
        if (stale(mine)) return;
        latest.current = next;
        if (next.secret_once) setSecret(next.secret_once);
      } catch (e) {
        patchRow('link', { status: 'failed', output: errorSentence(e) });
        fail('other');
        return;
      }
      await waitForLink(address, mine);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, fail, patchRow, pauseMs, updateApi, waitForLink],
  );

  useEffect(() => {
    alive.current = true;
    if (!started.current) {
      started.current = true;
      void start(null);
    }
    return () => {
      alive.current = false;
      // Closed without Cancel (the page behind went away): stop the tool too. StrictMode remounts at once, so look a tick later.
      setTimeout(() => {
        if (alive.current || phaseRef.current !== 'running' || cancelSent.current) return;
        cancelSent.current = true;
        void Promise.resolve(updateApiRef.current.cancel?.()).catch(() => undefined);
      }, 0);
    };
  }, [start]);

  const finish = () => {
    // "Cancel": the tool this run started is stopped too (nothing else is touched).
    if (phase === 'running' && !cancelSent.current) {
      cancelSent.current = true;
      void Promise.resolve(updateApi.cancel?.()).catch(() => undefined);
    }
    cancelled.current = true;
    runId.current++;
    if (phase === 'done' && latest.current) onStatus?.(latest.current);
    onClose(phase === 'done' ? saved.current : null);
  };

  useDismissable(true, {
    inside: [sheetRef],
    ignore: ['focus', 'blur', 'scroll'],
    // While a setup runs, a click outside or Escape does nothing (coming back from the Cloudflare page must not lose it);
    // the Cancel button is the only way out.
    onDismiss: () => (phase === 'running' ? undefined : asking ? setAsking(false) : finish()),
  });

  const retry = () => {
    if (problem === 'linking' && saved.current) {
      const mine = ++runId.current;
      cancelled.current = false;
      setProblem(null);
      setPhase('running');
      void waitForLink(saved.current, mine);
      return;
    }
    void start(null);
  };

  const label = (id: RowId) => (id === 'link' ? t('relaySetup.step.link') : t(`wu.step.${id}` as 'wu.step.prepare'));
  const running = phase === 'running';
  const details = scrubDetails(
    rows
      .filter((r) => r.output)
      .map((r) => `${label(r.id)}\n${r.output}`)
      .join('\n\n'),
  );
  const fix = problem ? PROBLEM_FIX[problem] : null;

  return (
    <div className="stable-overlay" role="presentation">
      <div
        ref={sheetRef}
        className="stable-sheet rs-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('relaySetup.title')}
        data-testid="relay-sheet"
        data-phase={phase}
      >
        <h3 className="rs-title">{phase === 'done' ? t('relaySetup.done') : t('relaySetup.title')}</h3>
        {phase !== 'done' && <p className="rs-sub">{t('relaySetup.sub')}</p>}

        <ol className="ss-steps" data-testid="relay-steps" aria-live="polite">
          {rows.map((r, index) => (
            <li key={r.id} className="ss-step" data-step={r.id} data-status={r.status}>
              <span className="ss-num" aria-hidden="true">
                {r.status === 'done' ? '✓' : r.status === 'failed' ? '!' : index + 1}
              </span>
              <span className="ss-text">
                <span className="ss-label">{label(r.id)}</span>
                {r.id === 'login' && (r.status === 'running' || r.status === 'retrying') && (
                  <small data-testid="relay-wait-login">{t('relaySetup.waitLogin')}</small>
                )}
              </span>
              <span className="ss-state">
                {r.status === 'done'
                  ? t('setupStep.status.done')
                  : r.status === 'failed'
                    ? t('relaySetup.state.failed')
                    : r.status === 'running' || r.status === 'retrying'
                      ? t('setupStep.status.running')
                      : ''}
              </span>
            </li>
          ))}
        </ol>

        {phase === 'done' && (
          <div className="rs-done" data-testid="relay-done" role="status">
            <p className="rs-ready">
              <span className="font-mono break-all" data-testid="relay-done-host">
                {linkedHost}
              </span>
              <span className="cn-relay-status" data-testid="relay-done-status">
                {t('connect.relay.status.linked')}
              </span>
            </p>
            {secret && (
              <div className="rs-key" data-testid="relay-key">
                <button type="button" className="rs-link" data-testid="relay-key-toggle" aria-expanded={keyOpen} onClick={() => setKeyOpen((v) => !v)}>
                  {t('relaySetup.key.show')}
                </button>
                {keyOpen && (
                  <>
                    <p className="rs-help">{t('relaySetup.key.help')}</p>
                    <SecretValue value={secret} copyLabel={t('relaySetup.key.copy')} />
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {phase === 'problem' && problem && (
          <div className="ss-fail rs-fail" data-testid="relay-problem" data-problem={problem}>
            <p className="ss-fail-line" role="alert">
              {t(`relaySetup.problem.${problem}` as 'relaySetup.problem.other')}
            </p>
            {asking ? (
              <div role="alertdialog" aria-label={t('wu.fresh')} data-testid="relay-fresh-confirm">
                <p>{t('relaySetup.freshSure')}</p>
                <div className="ss-fail-actions">
                  <button type="button" className="ss-btn ss-btn--primary" data-testid="relay-fresh-yes" onClick={() => void start(saved.current)}>
                    {t('wu.freshYes')}
                  </button>
                  <button type="button" className="ss-btn" data-testid="relay-fresh-no" onClick={() => setAsking(false)}>
                    {t('wu.freshNo')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="ss-fail-actions">
                {fix === 'fresh' && (
                  <button type="button" className="ss-btn ss-btn--primary" data-testid="relay-fix" onClick={() => setAsking(true)}>
                    {t('wu.fresh')}
                  </button>
                )}
                {fix === 'cloudflare' && (
                  <>
                    <button
                      type="button"
                      className="ss-btn ss-btn--primary"
                      data-testid="relay-fix"
                      onClick={() => void Promise.resolve(openExternal(CLOUDFLARE)).catch(() => undefined)}
                    >
                      {t('relaySetup.cloudflare')}
                    </button>
                    <button type="button" className="ss-btn" data-testid="relay-retry" onClick={retry}>
                      {t('relaySetup.retry')}
                    </button>
                  </>
                )}
                {fix === 'retry' && (
                  <button type="button" className="ss-btn ss-btn--primary" data-testid="relay-fix" onClick={retry}>
                    {t('relaySetup.retry')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {details && (
          <div className="rs-details">
            <button type="button" className="rs-link" data-testid="relay-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((v) => !v)}>
              {t('relaySetup.details')}
            </button>
            {detailsOpen && (
              <pre className="rs-pre" data-testid="relay-details">
                {details}
              </pre>
            )}
          </div>
        )}

        <div className="rs-foot">
          {running ? (
            <button type="button" className="ss-btn" data-testid="relay-cancel" onClick={finish}>
              {t('relaySetup.cancel')}
            </button>
          ) : (
            <button type="button" className={`ss-btn${phase === 'done' ? ' ss-btn--primary' : ''}`} data-testid="relay-close" onClick={finish}>
              {phase === 'done' ? t('relaySetup.finish') : t('stable.close')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
