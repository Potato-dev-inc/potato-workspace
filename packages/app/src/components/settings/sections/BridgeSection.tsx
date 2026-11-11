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
    label: 'Toolbelt',
    hint: "Add an MCP server once; Potato Workspace writes it into every agent's own config.",
    keywords: 'mcp servers apply to all agents import secrets scope',
    render: (env) => <ToolbeltGroup projectPath={installPathOf(env) || null} />,
  },
  {
    id: 'agent-pack',
    label: 'Add Potato Workspace to your agents',
    hint: 'Teach each agent when to ask another for help. Review first; Undo puts it back.',
    keywords: 'skills skill plugin install teach delegate second opinion claude code codex cursor opencode add agents undo',
    render: () => <AgentPackGroup />,
  },
  {
    id: 'bridge-endpoint',
    label: 'Bridge address',
    hint: 'Where other tools reach Potato Workspace on this computer. Found automatically.',
    keywords: 'bridge endpoint port ports url local http address 17421 17499',
    group: 'Bridge',
    render: (env) => (
      <InfoRow
        label="Bridge address"
        description="Where other tools reach Potato Workspace on this computer. Found automatically."
        value={env.bridgeUrl ?? 'Not found yet'}
      />
    ),
  },
  {
    id: 'mcp-status',
    label: 'Runtime status',
    hint: 'Checks the bridge, MCP runtime, Node.js and agent configs. Repair fixes project files.',
    keywords: 'status repair recheck node nodejs npx npm cursor claude desktop codex opencode bridge port mcp.json runtime health',
    group: 'Bridge',
    render: (env) => <McpStatusBlock env={env} />,
  },
  {
    id: 'rust-mcp',
    label: 'Use bundled Rust MCP',
    hint: 'When on, MCP configs start the bundled Rust MCP instead of npx.',
    keywords: 'rust binary bundled npx npm node runtime developer',
    group: 'Bridge',
    render: (env) => (
      <SettingToggle
        label="Use bundled Rust MCP"
        description="When on, MCP configs start the bundled Rust MCP instead of npx."
        checked={Boolean(env.settings.developer_use_rust_mcp)}
        onChange={(value) => void env.patch({ developer_use_rust_mcp: value })}
      />
    ),
  },
  {
    id: 'mcp-install',
    label: 'Install MCP runtime',
    hint: 'Register Claude, Codex and OpenCode to use the selected runtime.',
    keywords: 'install register claude code codex opencode cursor claude desktop npx node repair mcp.json project global runtime',
    group: 'Install',
    render: (env) => <McpInstallBlock env={env} />,
  },
  {
    id: 'snippet-claude-desktop',
    label: 'Claude Desktop config',
    hint: "Add this to Claude Desktop's MCP settings by hand. Potato Workspace won't write it.",
    keywords: 'claude desktop config json mcp.json cursor npx manual copy',
    group: 'Install',
    render: () => <CodeBlock title="Claude Desktop config" code={CLAUDE_DESKTOP_MCP} />,
  },
  {
    id: 'snippet-codex',
    label: 'Codex config',
    hint: 'Copy this if you set up Codex by hand instead of using Install.',
    keywords: 'codex config toml mcp_servers npx node manual copy',
    group: 'Install',
    render: () => <CodeBlock title="Codex config" code={CODEX_MCP} />,
  },
  ...securityRows,
  {
    id: 'mcp-uninstall',
    label: 'Uninstall MCP',
    hint: 'Removes the app from agent configs. The app and package stay. Restart MCP hosts.',
    keywords: 'remove delete uninstall mcp.json codex opencode claude code cursor claude desktop global project config npx node',
    group: 'Uninstall',
    danger: true,
    render: (env) => <McpUninstallBlock env={env} />,
  },
];
