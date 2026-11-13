// Install MCP runtime: register the selected runtime in each agent's config, for this project or globally.
import { useT } from '../../../../i18n';
import { installGlobalNpmMcpConfigs, installNpmMcpConfigs } from '../../../../lib/mcp-config';
import type { SettingsEnv } from '../../model';
import { Btn, Note, SettingBlock } from '../../settings-ui';
import { RESTART_NOTE, ResultLines, installPathOf, runtimeName, useMcpAction } from './shared';

export function McpInstallBlock({ env }: { env: SettingsEnv }) {
  const t = useT();
  const installPath = installPathOf(env);
  const { busy, results, error, run } = useMcpAction();

  return (
    <SettingBlock
      label={t('settings.row.mcp-install.label')}
      description={t('settings.row.mcp-install.hint')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Btn primary disabled={!installPath || busy !== null} onClick={() => void run('project', () => installNpmMcpConfigs(installPath))}>
          {busy === 'project' ? t('pack.installing') : t('bridge.connectProject')}
        </Btn>
        <Btn disabled={busy !== null} onClick={() => void run('global', () => installGlobalNpmMcpConfigs())}>
          {busy === 'global' ? t('pack.installing') : t('bridge.connectEverywhere')}
        </Btn>
      </div>
      <Note>{t('bridge.projectLine', { path: installPath || t('bridge.chooseFolder') })}</Note>
      {results && <ResultLines results={results} note={t('bridge.restartNote')} />}
      {error && <Note role="alert">{error}</Note>}
    </SettingBlock>
  );
}
