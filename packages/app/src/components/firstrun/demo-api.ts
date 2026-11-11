// Opens the demo: a visible pane for the main agent, in the chosen project, with the demo prompt sent
// once the pane is ready. Behind an interface so tests and the harness pass a fake.
import { cockpitApi } from '../../lib/cockpit-api';
import { tauri } from '../../lib/tauri';
import { firstRunApi } from './first-run-api';
import type { CockpitApi } from '../../hooks/useCockpit';

export interface DemoApi {
  /**
   * Resolves to the pane id, whether a warm worker was used and (when `needsMcp`) whether the agent reaches
   * this app's MCP bridge, or null when the agent did not open. Without MCP the prompt is NOT sent.
   */
  start: (c: Pick<CockpitApi, 'newAgent'>, agentId: string, project: string, prompt: string, needsMcp?: boolean) => Promise<{ paneId: string; warm: boolean; mcp: boolean } | null>;
}

const READY_WAIT_MS = 25_000;
const MCP_WAIT_MS = 8_000;
const POLL_MS = 100;

export const demoApi: DemoApi = {
  async start(c, agentId, project, prompt, needsMcp = false) {
    // Listen first: a warm agent says "ready" before `newAgent` returns.
    const ready = new Map<string, boolean>();
    const off = await cockpitApi
      .onSpawnStage((e) => {
        if (e.stage === 'ready' && e.pane_id) ready.set(e.pane_id, e.warm);
      })
      .catch(() => null);
    try {
      const paneId = await c.newAgent(agentId, undefined, false, project);
      if (!paneId) return null;
      const until = Date.now() + READY_WAIT_MS;
      while (!ready.has(paneId) && Date.now() < until) await new Promise((r) => setTimeout(r, POLL_MS));
      let mcp = true;
      if (needsMcp) {
        const stop = Date.now() + MCP_WAIT_MS;
        mcp = await firstRunApi.paneMcp(paneId).catch(() => false);
        while (!mcp && Date.now() < stop) {
          await new Promise((r) => setTimeout(r, 400));
          mcp = await firstRunApi.paneMcp(paneId).catch(() => false);
        }
      }
      if (mcp) await tauri.writeInput(paneId, prompt, true);
      return { paneId, warm: ready.get(paneId) === true, mcp };
    } finally {
      off?.();
    }
  },
};
