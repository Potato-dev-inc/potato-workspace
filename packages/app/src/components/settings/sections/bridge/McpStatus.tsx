// Runtime status: the local bridge, the MCP runtime, Node.js and each agent's config. It owns its state and
// re-checks when the project folder changes or when an install or uninstall announces a change.
import { errorSentence } from '../../../../lib/sayError';
import { t, useT } from '../../../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { getMcpStatus, type EnsureMcpResult, type McpStatusReport } from '../../../../lib/mcp-config';
import type { SettingsEnv } from '../../model';
import { Btn, Note, SettingBlock } from '../../settings-ui';
import { MCP_CHANGED_EVENT, RESTART_NOTE, ResultLines, StatusLine, installPathOf, runtimeName } from './shared';


function bridgeDetail(status: McpStatusReport, fallbackUrl: string | null): string {
  if (status.bridgeReachable) {
    return `${status.bridgeUrl ?? fallbackUrl ?? t('bridge.local')}${status.bridgeVersion ? ` · v${status.bridgeVersion}` : ''}`;
  }
  if (status.portFileExists) return t('bridge.portFile', { path: status.portFilePath });
  return t('bridge.startApp');
}

function runtimeDetail(status: McpStatusReport, rust: boolean): string {
  if (rust) return t('bridge.using', { cmd: status.launchCommand });
  if (status.npmPackageVersion) return t('bridge.via', { version: status.npmPackageVersion, cmd: status.launchCommand });
  if (status.npmAvailable) return t('bridge.npmNoResolve');
  return t('bridge.installNode');
}

export function McpStatusBlock({ env }: { env: SettingsEnv }) {
  const t = useT();
  const installPath = installPathOf(env);
  const rust = Boolean(env.settings.developer_use_rust_mcp);
  const [status, setStatus] = useState<McpStatusReport | null>(null);
  const [repairs, setRepairs] = useState<EnsureMcpResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(Boolean(installPath));

  const check = useCallback(
    async (autoRepair: boolean) => {
      if (!installPath) {
        setStatus(null);
        return;
      }
      setChecking(true);
      setError(null);
      try {
        const report = await getMcpStatus(installPath, autoRepair);
        setStatus(report);
        if (report.repairResults.length > 0) setRepairs(report.repairResults);
      } catch (e) {
        setStatus(null);
        setError(errorSentence(e));
      } finally {
        setChecking(false);
      }
    },
    [installPath],
  );

  useEffect(() => {
    void check(false);
  }, [check]);

  useEffect(() => {
    const onChanged = () => void check(false);
    window.addEventListener(MCP_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MCP_CHANGED_EVENT, onChanged);
  }, [check]);

  const headline = !installPath
    ? t('bridge.noProject')
    : status
      ? status.overallReady
        ? t('bridge.ready')
        : t('bridge.notReady')
      : checking
        ? t('agentPage.checking')
        : t('bridge.couldNotCheck');

  return (
    <SettingBlock
      label={t('settings.row.mcp-status.label')}
      description={t('settings.row.mcp-status.hint')}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Btn disabled={!installPath || checking} onClick={() => void check(true)}>
          {checking ? t('agentPage.checking') : t('bridge.checkRepair')}
        </Btn>
        <Note role="status">{headline}</Note>
      </div>
      {status && (
        <div>
          <StatusLine label={t('bridge.httpBridge')} value={status.bridgeReachable ? t('bridge.ok') : t('bridge.needsAttention')} detail={bridgeDetail(status, env.bridgeUrl)} />
          <StatusLine
            label={rust ? t('bridge.mcpRuntime') : t('bridge.npmPackage')}
            value={rust || (status.npmAvailable && Boolean(status.npmPackageVersion)) ? t('bridge.ok') : t('bridge.needsAttention')}
            detail={runtimeDetail(status, rust)}
          />
          <StatusLine
            label="Node.js" // i18n-ok: product name
            value={status.nodeAvailable ? t('bridge.ok') : t('bridge.needsAttention')}
            detail={status.nodeAvailable ? t('bridge.nodeOk') : t('bridge.nodeMissing')}
          />
          {status.backends.map((b) => (
            <StatusLine
              key={b.backend}
              label={b.label}
              value={b.installed ? (b.usesNpm ? t('bridge.installedNpm') : t('bridge.installedBundled')) : t('keepGoing.notInstalled')}
              detail={
                <>
                  {b.message}
                  <br />
                  <span className="break-all font-mono text-[10px]">{b.configPath}</span>
                </>
              }
            />
          ))}
        </div>
      )}
      {repairs && <ResultLines results={repairs} note={t('bridge.restartNote')} />}
      {error && <Note role="alert">{error}</Note>}
    </SettingBlock>
  );
}
