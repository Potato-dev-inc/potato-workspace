// One agent's logo, monochrome (currentColor), or its letters when we have no logo for it.
// The art comes from Simple Icons (CC0 1.0); see lib/agentLogos.ts.
import { agentLogoFor } from '../../lib/agentLogos';

export interface AgentLogoProps {
  /** The agent id from the registry (claude, codex, cursor_agent...). */
  id: string;
  /** The agent's name, for the accessible label. */
  name?: string;
  /** Pixels, square. Default 13. */
  size?: number;
  /** Letters shown when there is no logo. Default: the id's first two letters. null: draw nothing. */
  fallback?: string | null;
  /** True when the surrounding control already names the agent: the logo is then hidden from screen readers. */
  decorative?: boolean;
  className?: string;
}

export function AgentLogo({ id, name, size = 13, fallback, decorative = false, className }: AgentLogoProps) {
  const logo = agentLogoFor(id);
  if (logo) {
    const label = name ?? logo.title;
    return (
      <svg
        className={className}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        data-mark="logo"
        data-logo={logo.title}
        {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      >
        {decorative ? null : <title>{label}</title>}
        <path d={logo.path} />
      </svg>
    );
  }
  if (fallback === null) return null;
  return (
    <span className={className} data-mark="letters" aria-hidden={decorative ? true : undefined}>
      {fallback ?? id.slice(0, 2).toUpperCase()}
    </span>
  );
}
