// Settings > Agents > "Check my setup": one list of plain sentences. Each row has a tick, a "!" or a cross, and at most
// one fix button. "Copy report" copies every row as plain text, after the path and key scrubber (lib/setup-checks/report).
import { useCallback, useState } from 'react';
import { tauriAcpAddonApi } from '../../lib/acpAddon';
import { agentHealthApi } from '../../lib/agent-health';
import { useT } from '../../i18n';
import { openSettingsAt } from '../../lib/openSettingsAt';
import {
  buildReport,
  runAllChecks,
  tauriSetupDeps,
  type CheckRow,
  type FixAction,
  type SetupCheckContext,
  type SetupCheckDeps,
} from '../../lib/setup-checks';
import { Btn, Note } from './settings-ui';
import { problemWords } from './problem-words';
import { useRunSetupChecks, useSharedSetupChecks } from './setup-source';

export interface SetupCheckActions {
  signIn: (agentId: string) => void;
  installAddon: (agentId: string) => Promise<void> | void;
  /** Runs the deep check of one agent ("Test", "Try again"). */
  test?: (agentId: string) => Promise<void> | void;
}

/** Where each fix button goes. Settings-page defaults; tests pass fakes. */
export const DEFAULT_SETUP_ACTIONS: SetupCheckActions = {
  signIn: () => openSettingsAt('agents', 'agent-lane'),
  installAddon: (agentId) => tauriAcpAddonApi.install(agentId).then(() => undefined),
  test: (agentId) => agentHealthApi.test(agentId).then(() => undefined),
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
  }
}

const GLYPH: Record<CheckRow['status'], string> = { ok: '✓', warn: '!', fail: '×' };

/** The header line's left side: how the checks came out, in the same words as the Overview card. */
function summary(rows: CheckRow[] | null, t: ReturnType<typeof useT>): string {
  if (rows === null) return t('overview.setup.checks');
  return problemWords(rows) ?? t('overview.setup.everythingWorks');
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
  const own = useRunSetupChecks(() => runAllChecks(deps, ctx), shared === null);
  const source = shared ?? own;
  const actions = actionsProp ?? shared?.actions ?? DEFAULT_SETUP_ACTIONS;
  const rows = source.result.state === 'ready' ? source.result.rows : source.result.state === 'failed' ? [] : null;
  const [message, setMessage] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = source.refresh;

  const fix = useCallback(
    async (f: FixAction) => {
      setBusy(true);
      setMessage(null);
      try {
        await runFix(f, actions);
        refresh();
      } catch (error) {
        setMessage({ tone: 'alert', text: error instanceof Error ? error.message : t('overview.setup.didNotWork') });
      } finally {
        setBusy(false);
      }
    },
    [actions, refresh, t],
  );

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
        <span className="st-setupcheck-summary">{summary(rows, t)}</span>
        <div>
          <Btn small disabled={rows === null} onClick={() => void copyReport()}>
            {t('overview.setup.copyReport')}
          </Btn>
          <Btn small disabled={rows === null} onClick={refresh}>
            {t('overview.setup.checkAgain')}
          </Btn>
        </div>
      </div>
      <div className="st-setupcheck-list" role="list">
        {rows === null && <p className="st-note">{t('overview.setup.checking')}</p>}
        {rows?.map((r) => (
          <div key={r.id} className="st-row st-setupcheck-row" role="listitem" data-status={r.status}>
            <span className="st-setupcheck-glyph" aria-hidden="true">
              {GLYPH[r.status]}
            </span>
            <span className="st-label">{r.sentence}</span>
            {r.fix && (
              <Btn small disabled={busy} onClick={() => void fix(r.fix as FixAction)}>
                {r.fix.label}
              </Btn>
            )}
          </div>
        ))}
      </div>
      {message && <Note role={message.tone}>{message.text}</Note>}
    </div>
  );
}
