// Uninstall MCP: remove potato-workspace from agent config files, for this project or globally. Always confirmed first.
import { uninstallGlobalNpmMcpConfigs, uninstallNpmMcpConfigs } from '../../../../lib/mcp-config';
import type { SettingsEnv } from '../../model';
import { Btn, Note, SettingBlock } from '../../settings-ui';
import { ResultLines, installPathOf, useMcpAction } from './shared';

export function McpUninstallBlock({ env }: { env: SettingsEnv }) {
  const installPath = installPathOf(env);
  const { busy, results, error, run } = useMcpAction();

  const uninstallProject = async () => {
    if (busy !== null || !installPath) return;
    const ok = await env.confirm({
      title: 'Uninstall MCP from project?',
      body: 'Remove potato-workspace from this project’s .mcp.json, .codex/config.toml, and opencode.json?',
      confirmLabel: 'Uninstall',
    });
    if (!ok) return;
    await run('project', () => uninstallNpmMcpConfigs(installPath));
  };

  const uninstallGlobal = async () => {
    if (busy !== null) return;
    const ok = await env.confirm({
      title: 'Uninstall global MCP?',
      body: 'Remove potato-workspace from global Claude, Codex, and OpenCode MCP configs?',
      confirmLabel: 'Uninstall',
    });
    if (!ok) return;
    await run('global', () => uninstallGlobalNpmMcpConfigs());
  };

  return (
    <SettingBlock
      label="Disconnect agents from Potato Workspace"
      description="Removes the app from agent settings. The app stays. Restart the agents."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Btn disabled={!installPath || busy !== null} onClick={() => void uninstallProject()}>
          {busy === 'project' ? 'Removing…' : 'Uninstall from project…'}
        </Btn>
        <Btn disabled={busy !== null} onClick={() => void uninstallGlobal()}>
          {busy === 'global' ? 'Removing…' : 'Uninstall globally…'}
        </Btn>
      </div>
      <Note>
        Project: removes .mcp.json, .codex/config.toml, and opencode.json entries. Global: removes Claude local and user MCP,
        ~/.mcp.json, ~/.codex/config.toml, and OpenCode global config. Cursor and Claude Desktop configs are manual: edit your
        host&apos;s MCP settings file.
      </Note>
      {results && <ResultLines results={results} />}
      {error && <Note role="alert">{error}</Note>}
    </SettingBlock>
  );
}
