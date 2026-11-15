// Settings > Agents > "Check my setup": one list of plain sentences. Each row has a tick, a "!" or a cross, and at most
// one fix button. "Copy report" copies every row as plain text, after the path and key scrubber (lib/setup-checks/report).
import { useCallback, useEffect, useState } from 'react';
import { tauriAcpAddonApi } from '../../lib/acpAddon';
import { agentHealthApi } from '../../lib/agent-health';
import { useT } from '../../i18n';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { requestAddAgentAction } from '../../lib/addAgentActions';
import {
  buildReport,
  rememberTest,
  runAllChecks,
  tauriSetupDeps,
  type CheckRow,
  type FixAction,
  type SetupCheckContext,
  type SetupCheckDeps,
} from '../../lib/setup-checks';
import { DotSpinner } from '../cockpit/DotSpinner';
import { Btn, Note } from './settings-ui';
import { problemWords } from './problem-words';
import { useRunSetupChecks, useSharedSetupChecks } from './setup-source';

export interface SetupCheckActions {
  signIn: (agentId: string) => void;
  installAddon: (agentId: string) => Promise<void> | void;
  /** Runs the deep check of one agent ("Test", "Try again"). */
  test?: (agentId: string) => Promise<void> | void;
  /** "Install" on a not-installed agent: shows where it is added. */
  install?: (agentId: string) => void;
  /** "Open it" on an agent that cannot be tested: opens it so the person can say hello. */
  open?: (agentId: string) => void;
}

/** Where each fix button goes. Settings-page defaults; tests pass fakes. */
export const DEFAULT_SETUP_ACTIONS: SetupCheckActions = {
  signIn: () => openSettingsAt('agents', 'agent-lane'),
  installAddon: (agentId) => tauriAcpAddonApi.install(agentId).then(() => undefined),
  // The answer is kept (with the time) so the row says what happened, now and the next time Settings opens.
  test: (agentId) => agentHealthApi.test(agentId).then((result) => rememberTest(result)),
  install: () => openSettingsAt('agents', 'add-agent'),
  open: (agentId) => requestAddAgentAction('terminal', agentId),
};

/** Runs the button's action. */
export function runFix(fix: FixAction, actions: SetupCheckActions): Promise<void> | void {
  switch (fix.kind) {
    case 'signin':
      return actions.signIn(fix.agentId ?? '');
    case 'installAddon':
      return actions.installAddon(fix.agentId ?? '');
    case 'test':
      return actions.test?.(fix.agentId ?? '');
    case 'install':
      return actions.install?.(fix.agentId ?? '');
    case 'open':
      return actions.open?.(fix.agentId ?? '');
  }
}

const GLYPH: Record<CheckRow['status'], string> = { ok: '✓', warn: '!', fail: '×', quiet: '–' };

/** The header line's left side: how the checks came out, in the same words as the Overview card. */
function summary(rows: CheckRow[] | null, t: ReturnType<typeof useT>): string {
  if (rows === null) return t('overview.setup.checks');
  return problemWords(rows) ?? t('overview.setup.everythingWorks');
}

/** A check that has not answered yet: a spinner and its name, in the same row shape as the answers. */
function CheckingRow({ label }: { label: string }) {
  return (
    <div className="st-row st-setupcheck-row" role="listitem" data-status="checking">
      <span className="st-setupcheck-glyph" aria-hidden="true">
        <DotSpinner status="running" size={3} label={label} />
      </span>
      <span className="st-label">{label}</span>
    </div>
  );
}

const groupName = (id: string, t: ReturnType<typeof useT>): string => (id === 'bridge' || id === 'agents' || id === 'addons' ? t(`overview.check.group.${id}`) : t('overview.check.group.all'));

/** Re-renders once a minute, so "Checked 3 min ago" keeps counting. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** "Checked just now", "Checked 3 min ago", "Checked 2 h ago", "Checked 4 days ago". */
export function checkedAgo(at: number | null, now: number, t: ReturnType<typeof useT>): string {
  if (at === null) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return t('overview.setup.checkedNow');
  if (minutes < 60) return t('overview.setup.checkedMinutes', { count: minutes });
  if (minutes < 60 * 24) return t('overview.setup.checkedHours', { count: Math.floor(minutes / 60) });
  return t('overview.setup.checkedDays', { count: Math.floor(minutes / 60 / 24) });
}

export interface SetupCheckPageProps {
  ctx: SetupCheckContext;
  deps?: SetupCheckDeps;
  actions?: SetupCheckActions;
  appVersion?: string;
  now?: () => Date;
  /** Clipboard writer; defaults to the browser clipboard. */
  copy?: (text: string) => Promise<void>;
}

export function SetupCheckPage({
  ctx,
  deps = tauriSetupDeps,
  actions: actionsProp,
  appVersion = 'dev',
  now = () => new Date(),
  copy,
}: SetupCheckPageProps) {
  // The rows come from the one shared source when the page sits under the Settings window (so the Overview cards
  // agree with this list); a page shown alone (a test) runs the checks itself.
  const t = useT();
  const shared = useSharedSetupChecks();
  const own = useRunSetupChecks((options) => runAllChecks(deps, ctx, options), shared === null);
  const source = shared ?? own;
  const actions = actionsProp ?? shared?.actions ?? DEFAULT_SETUP_ACTIONS;
  const rows = source.result.state === 'ready' ? source.result.rows : source.result.state === 'failed' ? [] : null;
  const [message, setMessage] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);
  // The row whose button is running. Only that row waits; the others stay pressable.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const refresh = source.refresh;
  const groups = source.groups ?? [];
  const busy = groups.some((g) => g.busy);
  const clock = useMinuteClock();

  const fix = useCallback(
    async (rowId: string, f: FixAction) => {
      setBusyId(rowId);
      setMessage(null);
      try {
        await runFix(f, actions);
        refresh();
      } catch (error) {
        setMessage({ tone: 'alert', text: error instanceof Error ? error.message : t('overview.setup.didNotWork') });
      } finally {
        setBusyId(null);
      }
    },
    [actions, refresh, t],
  );

  // "Check again": ask every agent that can be tested to answer once more, one after the other, then read the list.
  const checkAgain = async () => {
    const todo = (rows ?? []).filter((r) => r.fix?.kind === 'test');
    if (todo.length === 0) return refresh();
    setTestingAll(true);
    setMessage({ tone: 'status', text: t('overview.setup.testsRunning') });
    for (const r of todo) {
      setBusyId(r.id);
      try {
        await runFix(r.fix as FixAction, actions);
      } catch {
        /* one agent failing must not stop the others; its row says what happened */
      }
    }
    setBusyId(null);
    setTestingAll(false);
    setMessage(null);
    refresh();
  };

  const copyReport = async () => {
    if (!rows) return;
    const text = buildReport(rows, appVersion, now().toISOString().slice(0, 16).replace('T', ' '));
    try {
      await (copy ?? ((s: string) => navigator.clipboard.writeText(s)))(text);
      setMessage({ tone: 'status', text: t('overview.setup.reportCopied') });
    } catch {
      setMessage({ tone: 'alert', text: t('overview.setup.couldNotCopy') });
    }
  };

  return (
    <div className="st-setupcheck" data-testid="setup-check">
      <div className="st-setupcheck-head">
        <span className="st-setupcheck-left">
          <span className="st-setupcheck-summary">{summary(rows, t)}</span>
          {(busy || source.checkedAt != null) && <span className="st-setupcheck-when"> · {busy ? t('overview.setup.checking') : checkedAgo(source.checkedAt ?? null, clock, t)}</span>}
        </span>
        <div>
          <Btn small disabled={rows === null} onClick={() => void copyReport()}>
            {t('overview.setup.copyReport')}
          </Btn>
          <Btn small disabled={rows === null || testingAll || busy} onClick={() => void checkAgain()}>
            {t('overview.setup.checkAgain')}
          </Btn>
        </div>
      </div>
      <div className="st-setupcheck-list" role="list">
        {groups.length === 0 && <CheckingRow label={t('overview.setup.checking')} />}
        {groups.map((g) =>
          g.rows === null ? (
            <CheckingRow key={g.id} label={t('overview.setup.checkingOne', { name: groupName(g.id, t) })} />
          ) : (
            g.rows.map((r) => (
              <div key={r.id} className="st-row st-setupcheck-row" role="listitem" data-status={r.status} data-busy={g.busy ? 'true' : undefined}>
                <span className="st-setupcheck-glyph" aria-hidden="true">
                  {g.busy ? <DotSpinner status="running" size={3} label={t('overview.setup.checking')} /> : GLYPH[r.status]}
                </span>
                <span className="st-label">{r.sentence}</span>
                {r.fix && (
                  <Btn small disabled={busyId === r.id || testingAll || g.busy} onClick={() => void fix(r.id, r.fix as FixAction)}>
                    {busyId === r.id && r.fix.kind === 'test' ? t('overview.fix.testing') : r.fix.label}
                  </Btn>
                )}
              </div>
            ))
          ),
        )}

      </div>
      {message && <Note role={message.tone}>{message.text}</Note>}
    </div>
  );
}
