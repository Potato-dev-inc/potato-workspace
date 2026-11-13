import { useEffect, useRef } from 'react';
import { useT } from '../../i18n';

export type PetSizeName = 'small' | 'medium' | 'large';
export const PET_SIZES: readonly PetSizeName[] = ['small', 'medium', 'large'];

interface Props {
  size: PetSizeName;
  quiet: boolean;
  onHide: () => void;
  onSize: (size: PetSizeName) => void;
  onQuiet: () => void;
  onOff: () => void;
  onClose: () => void;
}

const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** The right-click menu: Hide for 1 hour, Size (S/M/L), Quiet, Turn off. Arrow keys move, Enter picks, Esc closes. */
export function PetMenu({ size, quiet, onHide, onSize, onQuiet, onOff, onClose }: Props) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true });
  }, []);

  const move = (event: React.KeyboardEvent) => {
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      event.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const pick = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <div ref={root} className="pet-menu" role="menu" aria-label={t('pet.menu.label')} onKeyDown={move}>
      <button type="button" role="menuitem" className="pet-menu-item" onClick={pick(onHide)}>
        {t('pet.menu.hide')}
      </button>
      <div className="pet-menu-group" role="group" aria-label={t('pet.menu.size')}>
        <span className="pet-menu-label" aria-hidden="true">
          {t('pet.menu.size')}
        </span>
        {PET_SIZES.map((name) => (
          <button
            key={name}
            type="button"
            role="menuitemradio"
            aria-checked={size === name}
            className="pet-menu-size"
            onClick={pick(() => onSize(name))}
          >
            {t(`pet.menu.${name}` as const)}
          </button>
        ))}
      </div>
      <button type="button" role="menuitemcheckbox" aria-checked={quiet} className="pet-menu-item" onClick={pick(onQuiet)}>
        <span className="pet-menu-check" aria-hidden="true">
          {quiet ? '✓' : ''}
        </span>
        {t('pet.menu.quiet')}
      </button>
      <button type="button" role="menuitem" className="pet-menu-item" onClick={pick(onOff)}>
        {t('pet.menu.off')}
      </button>
    </div>
  );
}
