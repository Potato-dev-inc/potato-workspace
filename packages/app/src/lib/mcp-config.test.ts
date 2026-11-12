import { describe, expect, it } from 'vitest';
import {
  POTATO_WORKSPACE_MCP_COMMAND,
  POTATO_WORKSPACE_MCP_NAME,
} from './mcp-config';

describe('mcp-config', () => {
  it('defines the potato-workspace MCP server identity', () => {
    expect(POTATO_WORKSPACE_MCP_NAME).toBe('potato-workspace');
    expect(POTATO_WORKSPACE_MCP_COMMAND.command).toBe('npx');
    expect(POTATO_WORKSPACE_MCP_COMMAND.args).toContain('@potato-workspace/mcp');
  });
});
