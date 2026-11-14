// One agent's mark in a 30 px tile, the same everywhere on the phone (header, drawer rows, new chat). The mark takes the brand colour
// where the brand has one that reads on both themes, and the text colour otherwise (a black logo must not turn into a white square).
// The optional dot sits on the tile's corner: orange = needs you, green = working, red = trouble. Nothing is named by agent here.
import { AgentLogo } from '../common/AgentLogo';
import type { StatusDot } from '../../lib/phone-status';
import '../../styles/phone-shell.css';

export function PhoneAgentTile({ id, name, dot = 'none', size = 30, decorative = true }: { id: string; name: string; dot?: StatusDot; size?: number; decorative?: boolean }) {
  return (
    <span className="ph-tile" style={{ width: size, height: size }} data-testid="phone-agent-tile">
      <AgentLogo id={id} name={name} size={Math.round(size * 0.6)} decorative={decorative} />
      {dot !== 'none' && <span className="ph-dot" data-state={dot} aria-hidden="true" />}
    </span>
  );
}
