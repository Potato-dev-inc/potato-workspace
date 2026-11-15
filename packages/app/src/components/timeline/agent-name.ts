// The agent's name for a label, when the screen was not given a better one (the registry's own label).
export function defaultAgentName(agentType: string): string {
  if (!agentType) return '';
  return agentType.charAt(0).toUpperCase() + agentType.slice(1).replace(/[_-]+/g, ' ');
}
