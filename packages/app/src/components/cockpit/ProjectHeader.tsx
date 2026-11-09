// The header line of a project group in the sidebar: a caret that folds the group, the folder's name (and how many
// agents when folded), a "+" that starts an agent in that folder, and a menu (rename, remove / add).
import { useEffect, useRef, useState } from 'react';
import { IconMore, IconPlus } from './Icons';

export interface ProjectHeaderProps {
  name: string;
  /** Agents in the group (shown while folded). */
  count: number;
  folded: boolean;
  /** Something in the group needs the person (shown as a mark while folded). */
  needs?: boolean;
  /** The folder was added by the person: rename and remove are offered. Else "Add to sidebar". */
  added: boolean;
  /** "Other" has no folder: no "+" and no menu. */
  hasFolder: boolean;
  onToggle: () => void;
  onNewAgent: () => void;
  onAdd: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
}

export function ProjectHeader({ name, count, folded, needs, added, hasFolder, onToggle, onNewAgent, onAdd, onRemove, onRename }: ProjectHeaderProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      moreRef.current?.focus();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const openMenu = (x: number, y: number) => hasFolder && setMenu({ x, y });
  const finishRename = (save: boolean) => {
    setRenaming(false);
    if (save) onRename(draft);
  };

  return (
    <div
      className="ck-proj-head"
      onContextMenu={(e) => {
        if (!hasFolder) return;
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
    >
      {renaming ? (
        <input
          className="ck-proj-rename"
          aria-label={`Name of ${name}`}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finishRename(true);
            else if (e.key === 'Escape') finishRename(false);
          }}
        />
      ) : (
        <button type="button" className="ck-proj-toggle" aria-expanded={!folded} onClick={onToggle} title={folded ? `Show ${name}` : `Hide ${name}`}>
          <span className={`ck-proj-caret${folded ? '' : ' is-open'}`} aria-hidden="true" />
          <span className="ck-proj-name">{name}</span>
          {folded && count > 0 && <span className={`ck-proj-count${needs ? ' is-needs' : ''}`}>{count}</span>}
        </button>
      )}
      {hasFolder && !renaming && (
        <>
          <button type="button" className="ck-proj-act" aria-label={`New agent in ${name}`} title={`New agent in ${name}`} onClick={onNewAgent}>
            <IconPlus />
          </button>
          <button
            type="button"
            ref={moreRef}
            className="ck-proj-act"
            aria-label={`More for ${name}`}
            title="More"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenu(r.left, r.bottom + 4);
            }}
          >
            <IconMore />
          </button>
        </>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="ck-menu ck-menu--fixed ck-menu--compact"
          role="menu"
          style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 190)), top: menu.y }}
        >
          {added ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="ck-menu-item"
                onClick={() => {
                  setMenu(null);
                  setDraft(name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="ck-menu-item"
                onClick={() => {
                  setMenu(null);
                  onRemove();
                }}
              >
                Remove from sidebar
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item"
              onClick={() => {
                setMenu(null);
                onAdd();
              }}
            >
              Add to sidebar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
