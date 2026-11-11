// Which logo each agent id draws. The art is in agentLogoData.ts (generated, Simple Icons, CC0). Add an agent by
// adding a row here (and its icon to scripts/gen-agent-logos.mjs if it is a new one). No row, no logo: the callers
// fall back to the agent's letters.
import { AGENT_LOGO_DATA, type AgentLogoData } from './agentLogoData';

const LOGO_FOR_AGENT: Record<string, string> = {
  claude: 'claude',
  codex: 'openai',
  cursor: 'cursor',
  cursor_agent: 'cursor',
  gemini: 'gemini',
  copilot: 'copilot',
  opencode: 'opencode',
  opencode_native: 'opencode',
  kimi: 'kimi',
  qwen: 'qwen',
  mistral_vibe: 'mistral',
  cline: 'cline',
};

export function agentLogoFor(agentId: string): AgentLogoData | null {
  const key = LOGO_FOR_AGENT[agentId.trim().toLowerCase()];
  return key ? (AGENT_LOGO_DATA[key] ?? null) : null;
}
