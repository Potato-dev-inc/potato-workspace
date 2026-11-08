// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_PACK_INSPECTION, AGENT_PACK_PREVIEW } from '../../../dev/fixtures';
import { groupAgents, pendingCount, visibleRows, type AgentPackApi } from '../../../lib/agent-pack';
import { AgentPackGroup } from './AgentPackGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockApi = AgentPackApi & { [K in keyof AgentPackApi]: ReturnType<typeof vi.fn> };

function mockApi(overrides: Partial<AgentPackApi> = {}): MockApi {
  return {
    preview: vi.fn(async () => AGENT_PACK_PREVIEW),
    apply: vi.fn(async () => ({
      ...AGENT_PACK_PREVIEW,
      dry_run: false,
      recorded: 9,
      agents: AGENT_PACK_PREVIEW.agents.map((a) => ({
        ...a,
        skills: a.skills && { ...a.skills, written: a.skills.status === 'ready' },
        mcp: a.mcp && { ...a.mcp, written: a.mcp.status === 'ready' },
      })),
    })),
    undo: vi.fn(async () => ({ restored: ['x'], removed: ['a', 'b'], skipped: [], recorded: 0 })),
    inspect: vi.fn(async () => AGENT_PACK_INSPECTION),
    saveCustom: vi.fn(async (args: { agent_id?: string; name?: string; path: string }) => ({
      id: args.agent_id ?? 'custom-x',
      name: args.name ?? 'Agy',
      config_path: args.path,
      format: 'json',
      key_path: 'mcpServers',
    })),
    forgetCustom: vi.fn(async () => undefined),
    pickFile: vi.fn(async () => AGENT_PACK_INSPECTION.path),
    pickFolder: vi.fn(async () => 'C:/Users/dev/.agy/skills'),
    ...overrides,
  } as MockApi;
}

let host: HTMLDivElement;
let root: Root;

async function render(api: AgentPackApi) {
  await act(async () => {
    root.render(<AgentPackGroup api={api} />);
  });
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('AgentPackGroup', () => {
  it('says which agents it found and offers a review, with no Undo before anything is installed', async () => {
    await render(mockApi());
    expect(host.textContent).toContain('Found: Claude, Codex, OpenCode.');
    expect(button('Review and install')).toBeTruthy();
    expect(button('Undo')).toBeUndefined();
  });

  it('shows the skills and the connection per agent before anything is written', async () => {
    const api = mockApi();
    await render(api);
    await click(button('Review and install'));
    const rows = Array.from(document.querySelectorAll('[data-testid="pack-agent"]'));
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Claude');
    expect(rows[0].textContent).toContain('4 skills to add');
    expect(rows[0].textContent).toContain('Already connected to Potato Workspace');
    expect(rows[1].textContent).toContain('Connection to Potato Workspace will be added');
    expect(document.querySelector('[data-testid="pack-absent"]')?.textContent).toBe('Not on this computer: Cursor Agent.');
    expect(api.apply).not.toHaveBeenCalled();
    await click(button('Show details'));
    expect(document.body.textContent).toContain('potato-workspace/SKILL.md');
  });

  it('offers to fix a connection that pointed at a program that does not exist, and says when the program is missing', async () => {
    const [claude, codex, opencode] = AGENT_PACK_PREVIEW.agents;
    const preview = {
      ...AGENT_PACK_PREVIEW,
      agents: [
        claude,
        { ...codex, mcp: { ...codex.mcp!, change: 'update' as const } },
        { ...opencode, mcp: { ...opencode.mcp!, status: 'skipped' as const, reason: "Can't set up: the Potato Workspace tool program is missing from this install." } },
      ],
    };
    await render(mockApi({ preview: vi.fn(async () => preview) }));
    await click(button('Review and install'));
    const rows = Array.from(document.querySelectorAll('[data-testid="pack-agent"]'));
    expect(rows[1].textContent).toContain("Fix the Potato Workspace connection (it pointed at a program that doesn't exist)");
    expect(rows[1].textContent).not.toContain('will be added');
    expect(rows[2].textContent).toContain("Can't set up: the Potato Workspace tool program is missing from this install");
  });

  it('installs, announces where, and then offers Undo', async () => {
    const api = mockApi({ preview: vi.fn().mockResolvedValueOnce(AGENT_PACK_PREVIEW).mockResolvedValueOnce(AGENT_PACK_PREVIEW).mockResolvedValue({ ...AGENT_PACK_PREVIEW, recorded: 9 }) });
    await render(api);
    await click(button('Review and install'));
    await click(button('Install'));
    expect(api.apply).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Added to Claude, Codex, OpenCode.');
    expect(host.textContent).toContain('Restart open agents');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button('Undo')).toBeTruthy();
  });

  it('undoes and says how many things were put back', async () => {
    const api = mockApi({ preview: vi.fn(async () => ({ ...AGENT_PACK_PREVIEW, recorded: 9 })) });
    await render(api);
    await click(button('Undo'));
    expect(api.undo).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Undone. 3 items were put back as before.');
  });

  it('disables Install when every agent is already set up', async () => {
    const done = {
      ...AGENT_PACK_PREVIEW,
      agents: AGENT_PACK_PREVIEW.agents.map((a) => ({
        ...a,
        skills: a.skills && { ...a.skills, status: a.skills.status === 'ready' ? ('unchanged' as const) : a.skills.status },
        mcp: a.mcp && { ...a.mcp, status: a.mcp.status === 'ready' ? ('unchanged' as const) : a.mcp.status },
      })),
    };
    await render(mockApi({ preview: vi.fn(async () => done) }));
    await click(button('Review and install'));
    expect(button('Install')?.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('Nothing to add.');
  });

  it('shows the agents it cannot set up yet, with a reason, under the Not on this computer line', async () => {
    const withAgy = { ...AGENT_PACK_PREVIEW, unsupported: [{ id: 'agy', label: 'Agy', installed: true }] };
    await render(mockApi({ preview: vi.fn(async () => withAgy) }));
    expect(host.textContent).toContain("Can't set up: Agy.");
    await click(button('Review and install'));
    const line = document.querySelector('[data-testid="pack-unsupported"]');
    expect(line?.textContent).toBe("Can't set up yet: Agy — Potato Workspace doesn't know where this agent keeps its settings yet.");
    expect(document.querySelector('[data-testid="pack-absent"]')?.textContent).toBe('Not on this computer: Cursor Agent.');
  });

  it('shows the backend reason when it sends one', async () => {
    const withReason = {
      ...AGENT_PACK_PREVIEW,
      unsupported: [{ id: 'agy', label: 'Agy', installed: true, reason: 'No MCP settings location or skills folder is known for this agent yet.' }],
    };
    await render(mockApi({ preview: vi.fn(async () => withReason) }));
    await click(button('Review and install'));
    expect(document.querySelector('[data-testid="pack-unsupported"]')?.textContent).toBe(
      "Can't set up yet: Agy — No MCP settings location or skills folder is known for this agent yet.",
    );
  });

  it('shows nothing for unsupported agents when the list is empty', async () => {
    const none = { ...AGENT_PACK_PREVIEW, unsupported: [] };
    await render(mockApi({ preview: vi.fn(async () => none) }));
    expect(host.textContent).not.toContain("Can't set up");
    await click(button('Review and install'));
    expect(document.querySelector('[data-testid="pack-unsupported"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Can't set up");
  });

  it('shows an error from the backend instead of failing silently', async () => {
    await render(mockApi({ preview: vi.fn(async () => Promise.reject(new Error('no home folder'))) }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('no home folder');
  });
});

const WITH_AGY = { ...AGENT_PACK_PREVIEW, unsupported: [{ id: 'agy', label: 'Agy', installed: true }] };

describe('Choose settings file', () => {
  it('offers both pickers on every agent it cannot set up, and an Other agent link', async () => {
    await render(mockApi({ preview: vi.fn(async () => WITH_AGY) }));
    await click(button('Review and install'));
    const row = document.querySelector('[data-testid="pack-unsupported-row"]');
    expect(row?.textContent).toContain('Choose settings file…');
    expect(row?.textContent).toContain('Choose skills folder…');
    expect(button('Other agent…')).toBeTruthy();
  });

  it('shows the detected format, key and exact entry after a file is chosen, and writes nothing yet', async () => {
    const api = mockApi({ preview: vi.fn(async () => WITH_AGY) });
    await render(api);
    await click(button('Review and install'));
    await click(button('Choose settings file…'));
    expect(api.pickFile).toHaveBeenCalledTimes(1);
    expect(api.inspect).toHaveBeenCalledWith('C:/Users/dev/.agy/settings.json');
    const card = document.querySelector('[data-testid="pack-inspection"]');
    expect(card?.textContent).toContain('Format: JSON');
    expect(card?.textContent).toContain('Server list: mcpServers');
    expect(card?.textContent).toContain('This entry will be added under mcpServers');
    expect(card?.textContent).toContain('"potato-workspace"');
    expect(card?.textContent).toContain('@potato-workspace/mcp');
    expect(api.saveCustom).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it('says an existing potato-workspace entry is left unchanged, and that a missing list will be created', async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ ...AGENT_PACK_INSPECTION, already_present: true })
      .mockResolvedValueOnce({ ...AGENT_PACK_INSPECTION, creates_list: true });
    await render(mockApi({ preview: vi.fn(async () => WITH_AGY), inspect }));
    await click(button('Review and install'));
    await click(button('Choose settings file…'));
    expect(document.querySelector('[data-testid="pack-inspection"]')?.textContent).toContain('already in this list. It is left unchanged');
    await click(button('Choose settings file…'));
    expect(document.querySelector('[data-testid="pack-inspection"]')?.textContent).toContain('this file has none yet');
  });

  it('keeps the choice with the skills folder, then reloads the plan', async () => {
    const api = mockApi({ preview: vi.fn(async () => WITH_AGY) });
    await render(api);
    await click(button('Review and install'));
    await click(button('Choose skills folder…'));
    expect(document.querySelector('[data-testid="pack-skills-pick"]')?.textContent).toContain('C:/Users/dev/.agy/skills');
    await click(button('Choose settings file…'));
    const before = (api.preview as ReturnType<typeof vi.fn>).mock.calls.length;
    await click(button('Use this file'));
    expect(api.saveCustom).toHaveBeenCalledWith({ agent_id: 'agy', name: undefined, path: AGENT_PACK_INSPECTION.path, skills_dir: 'C:/Users/dev/.agy/skills' });
    expect((api.preview as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });

  it('shows the backend reason when a file is refused, with no entry preview', async () => {
    const inspect = vi.fn(async () => Promise.reject(new Error('This file has no MCP list Potato Workspace recognises.')));
    await render(mockApi({ preview: vi.fn(async () => WITH_AGY), inspect }));
    await click(button('Review and install'));
    await click(button('Choose settings file…'));
    expect(document.body.textContent).toContain('This file has no MCP list Potato Workspace recognises.');
    expect(document.querySelector('[data-testid="pack-inspection"]')).toBeNull();
    expect(button('Use this file')).toBeUndefined();
  });

  it('does nothing when the picker is cancelled', async () => {
    const api = mockApi({ preview: vi.fn(async () => WITH_AGY), pickFile: vi.fn(async () => null) });
    await render(api);
    await click(button('Review and install'));
    await click(button('Choose settings file…'));
    expect(api.inspect).not.toHaveBeenCalled();
  });

  it('adds an agent Potato Workspace does not know: name first, then the same pickers', async () => {
    const api = mockApi({ preview: vi.fn(async () => ({ ...AGENT_PACK_PREVIEW, unsupported: [] })) });
    await render(api);
    await click(button('Review and install'));
    await click(button('Other agent…'));
    await click(button('Choose settings file…'));
    expect(button('Use this file')?.hasAttribute('disabled')).toBe(true);
    const input = document.querySelector('input[aria-label="Agent name"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'My Agent');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Use this file')?.hasAttribute('disabled')).toBe(false);
    await click(button('Use this file'));
    expect(api.saveCustom).toHaveBeenCalledWith({ agent_id: undefined, name: 'My Agent', path: AGENT_PACK_INSPECTION.path, skills_dir: undefined });
    expect(button('Other agent…')).toBeTruthy();
  });

  it('lets the user forget a settings file they chose', async () => {
    const chosen = {
      ...AGENT_PACK_PREVIEW,
      custom: [{ id: 'codex', name: 'Codex', config_path: 'C:/Users/dev/.codex/config.toml', format: 'toml', key_path: 'mcp_servers' }],
    };
    const api = mockApi({ preview: vi.fn(async () => chosen) });
    await render(api);
    await click(button('Review and install'));
    expect(document.querySelectorAll('[data-testid="pack-chosen"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="pack-chosen"]')?.textContent).toContain('Settings file you chose');
    await click(button('Forget'));
    expect(api.forgetCustom).toHaveBeenCalledWith('codex');
  });
});

describe('grouping', () => {
  it('merges agents that share their folders and hides the ones that are not on this computer', () => {
    const shared = {
      ...AGENT_PACK_PREVIEW,
      agents: [
        ...AGENT_PACK_PREVIEW.agents,
        { ...AGENT_PACK_PREVIEW.agents[2], id: 'opencode_native', label: 'OpenCode (API)' },
      ],
    };
    const rows = groupAgents(shared.agents);
    expect(rows.find((r) => r.labels.includes('OpenCode'))?.labels).toEqual(['OpenCode', 'OpenCode (API)']);
    expect(visibleRows(rows).map((r) => r.labels[0])).toEqual(['Claude', 'Codex', 'OpenCode']);
    expect(pendingCount(visibleRows(rows))).toBe(3);
  });
});
