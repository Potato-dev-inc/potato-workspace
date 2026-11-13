import { useEffect, useRef, useState, type FC } from 'react';
import { Pet } from '../components/pet/Pet';
import type { PetBubble, PetView, SpriteName, PetPlay } from '../components/pet/petModel';

// Desktop Potato in each state, drawn with the real Pet component and CSS on a mock dark desktop. The real window
// is transparent and sits on the person's desktop; this only shows what is drawn. No window is ever opened.

interface Cell {
  title: string;
  sprite: SpriteName;
  play?: PetPlay;
  bubble?: PetBubble | null;
  needsCount?: number;
  resting?: boolean;
  quiet?: boolean;
  menu?: boolean;
}

const CELLS: Cell[] = [
  { title: 'Awake, resting', sprite: 'idle' },
  { title: 'Sleepy', sprite: 'sleepy', resting: true },
  { title: 'Asleep', sprite: 'sleep', resting: true },
  { title: 'Quiet (hours or choice)', sprite: 'sleep', resting: true, quiet: true },
  { title: 'Agent needs you: waves', sprite: 'wave-hello', needsCount: 1, bubble: { kind: 'needs', agent: 'Claude', paneId: 'p1', until: null } },
  { title: 'Still waiting', sprite: 'needs-you', needsCount: 2, bubble: { kind: 'needs', agent: 'Codex', paneId: 'p2', until: null } },
  { title: 'Run finished', sprite: 'celebrate', bubble: { kind: 'done', agent: 'Gemini', paneId: 'p3', until: null } },
  { title: 'Talking', sprite: 'talk', bubble: { kind: 'say', text: 'Good morning! 3 notes are waiting.', until: null } },
  { title: 'Walking', sprite: 'walk-right' },
  { title: 'Being carried', sprite: 'dragged' },
  { title: 'Landed', sprite: 'land' },
  { title: 'Right-click menu', sprite: 'idle', menu: true },
];

const noop = () => undefined;

const PetCell: FC<{ cell: Cell }> = ({ cell }) => {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!cell.menu) return;
    host.current?.querySelector('.pet-body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }, [cell.menu]);
  const view: PetView = {
    sprite: cell.sprite,
    play: 'still',
    bubble: cell.bubble ?? null,
    needsCount: cell.needsCount ?? 0,
    resting: cell.resting ?? false,
    quiet: cell.quiet ?? false,
  };
  return (
    <div className="pet-cell" ref={host}>
      <Pet
        view={view}
        size="medium"
        quietChoice={cell.quiet ?? false}
        onOpenAgent={noop}
        onLater={noop}
        onDismiss={noop}
        onDragStart={noop}
        onHide={noop}
        onSize={noop}
        onQuiet={noop}
        onOff={noop}
      />
      <span className="pet-cell-title">{cell.title}</span>
    </div>
  );
};

/** `columns`: how many cells per row (4 on a wide window, 3 on a narrow one). */
export const PetPreview: FC<{ columns?: number }> = ({ columns = 4 }) => {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <div className="pet-desktop" data-ready={ready ? 'true' : 'false'} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      <style>{`
        .pet-desktop{position:fixed;inset:0;z-index:99999;display:grid;gap:10px;padding:10px;background:linear-gradient(135deg,#2b3340,#1b2029);align-content:start}
        .pet-cell{position:relative;height:290px;border:1px dashed rgba(255,255,255,.16);border-radius:10px;overflow:hidden}
        .pet-cell .pet-root{position:absolute}
        .pet-cell-title{position:absolute;left:10px;top:8px;font:12px system-ui,sans-serif;color:rgba(255,255,255,.7)}
      `}</style>
      {CELLS.map((cell) => (
        <PetCell key={cell.title} cell={cell} />
      ))}
    </div>
  );
};
