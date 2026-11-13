// Uninstall MCP: remove potato-workspace from agent config files, for this project or globally. Always confirmed first.
import { useT } from '../../../../i18n';
import { uninstallGlobalNpmMcpConfigs, uninstallNpmMcpConfigs } from '../../../../lib/mcp-config';
import type { SettingsEnv } from '../../model';
import { Btn, Note, SettingBlock } from '../../settings-ui';
import { ResultLines, installPathOf, useMcpAction } from './shared';

export function McpUninstallBlock({ env }: { env: SettingsEnv }) {
  const t = useT();
  const installPath = installPathOf(env);
  const { busy, results, error, run } = useMcpAction();

  const uninstallProject = async () => {
    if (busy !== null || !installPath) return;
    const ok = await env.confirm({
      title: t('bridge.uninstallProjectTitle'),
      body: t('bridge.uninstallProjectBody'),
      confirmLabel: t('bridge.uninstall'),
    });
    if (!ok) return;
    await run('project', () => uninstallNpmMcpConfigs(installPath));
  };

  const uninstallGlobal = async () => {
    if (busy !== null) return;
    const ok = await env.confirm({
      title: t('bridge.uninstallGlobalTitle'),
      body: t('bridge.uninstallGlobalBody'),
      confirmLabel: t('bridge.uninstall'),
    });
    if (!ok) return;
    await run('global', () => uninstallGlobalNpmMcpConfigs());
  };

  return (
    <SettingBlock
      label={t('settings.row.mcp-uninstall.label')}
      description={t('settings.row.mcp-uninstall.hint')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={!installPath || busy !== null} onClick={() => void uninstallProject()}>
          {busy === 'project' ? t('bridge.removing') : t('bridge.uninstallFromProject')}
        </Btn>
        <Btn disabled={busy !== null} onClick={() => void uninstallGlobal()}>
          {busy === 'global' ? t('bridge.removing') : t('bridge.uninstallGlobally')}
        </Btn>
      </div>
      <Note>{t('bridge.uninstallNote')}</Note>
      {results && <ResultLines results={results} />}
      {error && <Note role="alert">{error}</Note>}
    </SettingBlock>
  );
}
