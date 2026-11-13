// One agent's mark: its logo in the brand colour (Simple Icons, CC0 1.0; brand marks belong to their owners and are
// used only to identify the agent), or a clean monogram (first letter in a rounded square) when there is no
// published mark. Which logo an agent gets is data (lib/agentLogos.ts); nothing here names an agent.
import type { CSSProperties } from 'react';
import { agentLogoFor, logoColors } from '../../lib/agentLogos';
import '../../styles/agent-logo.css';

export interface AgentLogoProps {
  /** The agent id from the registry (claude, codex, cursor_agent...). */
  id: string;
  /** The agent's name, for the accessible label and the monogram letter. */
  name?: string;
  /** Pixels, square. Default 13. */
  size?: number;
  /** Text for the monogram instead of the first letter of the name. null: draw nothing when there is no logo. */
  fallback?: string | null;
  /** True when the surrounding control already names the agent: the mark is then hidden from screen readers. */
  decorative?: boolean;
  /** False: draw the logo in the surrounding text colour instead of its brand colour. Default true. */
  brand?: boolean;
  className?: string;
}

/** The letter shown for an agent without a logo: the first letter of its name (or id). */
export function monogramFor(id: string, name?: string, fallback?: string | null): string {
  const source = (fallback ?? name ?? id).trim() || id;
  return (Array.from(source.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? '?').toUpperCase();
}

export function AgentLogo({ id, name, size = 13, fallback, decorative = false, brand = true, className }: AgentLogoProps) {
  const logo = agentLogoFor(id);
  const cls = (base: string) => (className ? `${base} ${className}` : base);
  if (logo) {
    const label = name ?? logo.title;
    const colors = brand ? logoColors(logo) : { light: null, dark: null };
    const style = {
      ...(colors.light ? { '--al-light': colors.light } : {}),
      ...(colors.dark ? { '--al-dark': colors.dark } : {}),
    } as CSSProperties;
    return (
      <svg
        className={cls('pm-agent-logo')}
        style={style}
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
  const letter = monogramFor(id, name, fallback);
  return (
    <span
      className={cls('pm-agent-mono')}
      style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.62)) }}
      data-mark="monogram"
      data-letter={letter}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name ?? id })}
    />
  );
}
