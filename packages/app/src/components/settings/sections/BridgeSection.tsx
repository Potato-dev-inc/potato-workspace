// Settings > Bridge & MCP: the Toolbelt, the local bridge, the MCP runtime status, install and uninstall of
// the MCP configs for orchestrator hosts, and copyable snippets. Each block owns its state; installs and
// uninstalls announce themselves with the `pm-mcp-changed` event so the status re-checks.
import { POTATO_WORKSPACE_MCP_COMMAND } from '../../../lib/mcp-config';
import type { RowDef } from '../model';
import { CodeBlock, InfoRow, SettingToggle } from '../settings-ui';
import { AgentPackGroup } from '../pack/AgentPackGroup';
import { ToolbeltGroup } from '../toolbelt/ToolbeltGroup';
import { McpInstallBlock } from './bridge/McpInstall';
import { McpStatusBlock } from './bridge/McpStatus';
import { McpUninstallBlock } from './bridge/McpUninstall';
import { securityRows } from './bridge/Security';
import { installPathOf } from './bridge/shared';

const CLAUDE_DESKTOP_MCP = JSON.stringify({ mcpServers: { 'potato-workspace': POTATO_WORKSPACE_MCP_COMMAND } }, null, 2);
const CODEX_MCP = '[mcp_servers.potato-workspace]\ncommand = "npx"\nargs = ["-y","@potato-workspace/mcp"]';

export const bridgeRows: RowDef[] = [
  {
    id: 'toolbelt',
    label: 'Tools for every agent',
    hint: "Add a tool server once. It is written into each agent's settings.",
    keywords: 'toolbelt mcp servers apply to all agents import secrets scope',
    render: (env) => <ToolbeltGroup projectPath={installPathOf(env) || null} />,
  },
  {
    id: 'agent-pack',
    label: 'Let agents ask each other for help',
    hint: 'Teaches each agent when to ask another. Review first; Undo puts it back.',
    keywords: 'add potato workspace to your agents mcp skills skill plugin install teach delegate second opinion claude code codex cursor opencode add agents undo',
    render: () => <AgentPackGroup />,
  },
  {
    id: 'bridge-endpoint',
    label: 'Local address',
    hint: 'Where other tools reach this app on this computer. Found by itself.',
    keywords: 'bridge address endpoint port ports url local http address 17421 17499',
    group: 'Bridge',
    render: (env) => (
      <InfoRow
        label="Local address"
        description="Where other tools reach this app on this computer. Found by itself."
        value={env.bridgeUrl ?? 'Not found yet'}
      />
    ),
  },
  {
    id: 'mcp-status',
    label: 'Connection check',
    hint: "Checks the local address, the helper program and each agent's settings.",
    keywords: 'runtime status mcp bridge repair recheck node nodejs npx npm cursor claude desktop codex opencode bridge port mcp.json runtime health',
    group: 'Bridge',
    render: (env) => <McpStatusBlock env={env} />,
  },
  {
    id: 'rust-mcp',
    label: 'Use the built-in helper program',
    hint: 'On: agents start the helper that ships with the app. Off: they use npx.',
    keywords: 'bundled rust mcp binary bundled npx npm node runtime developer',
    group: 'Bridge',
    render: (env) => (
      <SettingToggle
        label="Use the built-in helper program"
        description="On: agents start the helper that ships with the app. Off: they use npx."
        checked={Boolean(env.settings.developer_use_rust_mcp)}
        onChange={(value) => void env.patch({ developer_use_rust_mcp: value })}
      />
    ),
  },
  {
    id: 'mcp-install',
    label: 'Connect Claude, Codex and OpenCode',
    hint: 'Writes the helper program into their settings.',
    keywords: 'install mcp runtime register claude code codex opencode cursor claude desktop npx node repair mcp.json project global runtime',
    group: 'Install',
    render: (env) => <McpInstallBlock env={env} />,
  },
  {
    id: 'snippet-claude-desktop',
    label: 'Set up Claude Desktop by hand',
    hint: "Copy this into Claude Desktop's settings. The app won't write it.",
    keywords: 'claude desktop config json mcp.json cursor npx manual copy',
    group: 'Install',
    render: () => <CodeBlock title="Set up Claude Desktop by hand" code={CLAUDE_DESKTOP_MCP} />,
  },
  {
    id: 'snippet-codex',
    label: 'Set up Codex by hand',
    hint: 'Copy this if you would rather not use Connect.',
    keywords: 'codex config toml mcp_servers npx node manual copy',
    group: 'Install',
    render: () => <CodeBlock title="Set up Codex by hand" code={CODEX_MCP} />,
  },
  ...securityRows,
  {
    id: 'mcp-uninstall',
    label: 'Disconnect agents from Potato Workspace',
    hint: 'Removes the app from agent settings. The app stays. Restart the agents.',
    keywords: 'uninstall mcp remove delete mcp.json codex opencode claude code cursor claude desktop global project config npx node',
    group: 'Uninstall',
    danger: true,
    render: (env) => <McpUninstallBlock env={env} />,
  },
];
