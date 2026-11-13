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

/** Brand colours for the dark and light themes. Null = no brand colour: the mark follows the text colour (very dark
 * marks, e.g. a black logo on a dark surface, would vanish). Pure data from the logo table, no agent is named here. */
export function logoColors(logo: AgentLogoData): { light: string | null; dark: string | null } {
  const hex = /^[0-9a-f]{6}$/i.test(logo.hex) ? logo.hex : null;
  if (!hex) return { light: null, dark: null };
  const lin = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return { light: lum > 0.7 ? null : `#${hex}`, dark: lum < 0.1 ? null : `#${hex}` };
}

export function agentLogoFor(agentId: string): AgentLogoData | null {
  const key = LOGO_FOR_AGENT[agentId.trim().toLowerCase()];
  return key ? (AGENT_LOGO_DATA[key] ?? null) : null;
}
