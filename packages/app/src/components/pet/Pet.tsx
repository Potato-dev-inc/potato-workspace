import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { PetMenu, type PetSizeName } from './PetMenu';
import { PetSprite } from './PetSprite';
import type { PetView } from './petModel';

export const SPRITE_PX: Record<PetSizeName, number> = { small: 96, medium: 128, large: 160 };
/** The pointer must move this far (px) with the button down before it is a drag and not a click. */
const DRAG_PX = 4;

export interface PetProps {
  view: PetView;
  size: PetSizeName;
  /** The person's Quiet choice (the menu check). */
  quietChoice: boolean;
  onOpenAgent: (paneId?: string) => void;
  onLater: () => void;
  onDismiss: () => void;
  /** The pointer moved with the button down: start moving the window. */
  onDragStart: () => void;
  onHide: () => void;
  onSize: (size: PetSizeName) => void;
  onQuiet: () => void;
  onOff: () => void;
  /** The pet needs room above it (a bubble or the menu is open) or gives it back. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Any touch by the person (wakes it up). */
  onTouch?: () => void;
}

/** The pet: the Potato, its speech bubble and its right-click menu. Presentational: all rules are in petModel. */
export function Pet(props: PetProps) {
  const { view, size, onExpandedChange } = props;
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const bubble = menuOpen ? null : view.bubble;
  const expanded = menuOpen || bubble !== null;

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    body.current?.focus({ preventScroll: true });
  }, []);

  // Click (or Enter) on the Potato: go to the agent that waits (or just finished); with nothing to show, the menu.
  const activate = () => {
    props.onTouch?.();
    if (view.bubble && view.bubble.kind !== 'say') props.onOpenAgent(view.bubble.paneId);
    else setMenuOpen(true);
  };

  const label = view.quiet ? t('pet.aria.quiet') : view.needsCount > 0 ? t('pet.aria.needs', { count: view.needsCount }) : t('pet.aria.resting');

  return (
    <div className="pet-root" data-sprite={view.sprite} data-expanded={expanded ? 'true' : 'false'}>
      {bubble && (
        <div className="pet-bubble" role="status" aria-live="polite" data-kind={bubble.kind}>
          <p className="pet-bubble-text">
            {bubble.kind === 'needs' && t('pet.needsYou', { agent: bubble.agent ?? '' })}
            {bubble.kind === 'done' && t('pet.finished', { agent: bubble.agent ?? '' })}
            {bubble.kind === 'say' && bubble.text}
          </p>
          <div className="pet-bubble-actions">
            {bubble.kind !== 'say' && (
              <button type="button" className="pet-btn is-primary" onClick={() => props.onOpenAgent(bubble.paneId)}>
                {t('pet.open')}
              </button>
            )}
            {bubble.kind === 'needs' ? (
              <button type="button" className="pet-btn" onClick={props.onLater}>
                {t('pet.later')}
              </button>
            ) : (
              <button type="button" className="pet-btn" onClick={props.onDismiss}>
                {t('pet.closeBubble')}
              </button>
            )}
          </div>
        </div>
      )}
      {menuOpen && (
        <PetMenu
          size={size}
          quiet={props.quietChoice}
          onHide={props.onHide}
          onSize={props.onSize}
          onQuiet={props.onQuiet}
          onOff={props.onOff}
          onClose={closeMenu}
        />
      )}
      <div
        ref={body}
        className="pet-body"
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          press.current = { x: event.clientX, y: event.clientY, dragging: false };
        }}
        onPointerMove={(event) => {
          const p = press.current;
          if (!p || p.dragging || event.buttons !== 1) return;
          if (Math.hypot(event.clientX - p.x, event.clientY - p.y) >= DRAG_PX) {
            p.dragging = true;
            setMenuOpen(false);
            props.onDragStart();
          }
        }}
        onPointerUp={(event) => {
          const p = press.current;
          press.current = null;
          if (event.button === 0 && p && !p.dragging) activate();
        }}
        onPointerCancel={() => {
          press.current = null;
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onTouch?.();
          setMenuOpen((open) => !open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        <PetSprite sprite={view.sprite} play={view.play} size={SPRITE_PX[size]} />
      </div>
    </div>
  );
}
