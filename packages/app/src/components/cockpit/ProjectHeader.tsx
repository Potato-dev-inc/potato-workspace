// The header line of a project card in the sidebar: a caret that folds the card, the folder's name, what changed
// (+ green, - red), a "+" that starts an agent in that folder, and a menu (rename, remove / add). A folded card shows
// the icons of the agents inside and its loudest signal, so nothing hides.
import { useRef, useState } from 'react';
import { AgentLogo } from '../common/AgentLogo';
import { IconMore, IconPlus } from './Icons';
import { useT } from '../../i18n';
import { Menu } from '../common/Floating';

export type ProjectSignal = 'needs' | 'error' | 'working' | null;

/** The second line of an open card: the branch the project folder is on. */
export function ProjectMeta({ branch }: { branch: string }) {
  const t = useT();
  return (
    <div className="ck-proj-meta">
      <span className="ck-proj-branch" title={branch}>
        {branch}
      </span>
      <span className="ck-pill-quiet">{t('sidebar.primary')}</span>
    </div>
  );
}

export interface ProjectHeaderProps {
  name: string;
  /** Agents in the group (shown while folded). */
  count: number;
  folded: boolean;
  /** Something in the group needs the person (shown as a mark while folded). */
  needs?: boolean;
  /** Lines added and removed across the project's separate copies. Absent: nothing changed that we know of. */
  changes?: { additions: number; deletions: number } | null;
  /** The agents inside, shown as icons while folded. */
  agents?: { id: string; agentType: string; label?: string }[];
  /** The loudest thing going on inside, shown beside the icons while folded. */
  signal?: ProjectSignal;
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

export function ProjectHeader({ name, count, folded, needs, changes, agents = [], signal = null, added, hasFolder, onToggle, onNewAgent, onAdd, onRemove, onRename }: ProjectHeaderProps) {
  const t = useT();
  /** Where the menu opened: the right-click point, or the "..." button (`fromMore`). */
  const [menu, setMenu] = useState<{ x: number; y: number; fromMore: boolean } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const moreRef = useRef<HTMLButtonElement>(null);

  const openMenu = (x: number, y: number, fromMore = false) => hasFolder && setMenu({ x, y, fromMore });
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
          aria-label={t('sidebar.nameOf', { name })}
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
        <button type="button" className="ck-proj-toggle" aria-expanded={!folded} onClick={onToggle} title={folded ? t('sidebar.showProject', { name }) : t('sidebar.hideProject', { name })}>
          <span className={`ck-proj-caret${folded ? '' : ' is-open'}`} aria-hidden="true" />
          <span className="ck-proj-name">{name}</span>
          {changes && (
            <span className="ck-proj-changes" title={t('sidebar.linesChanged', { added: changes.additions, removed: changes.deletions })}>
              <span className="ck-add">+{changes.additions}</span>
              <span className="ck-del">−{changes.deletions}</span>
            </span>
          )}
          {folded && (agents.length > 0 || signal) && (
            <span className="ck-proj-foldrow">
              {agents.length > 0 && (
                <span className="ck-proj-icons" aria-hidden="true">
                  {agents.slice(0, 4).map((a) => (
                    <AgentLogo key={a.id} id={a.agentType} name={a.label} size={12} decorative />
                  ))}
                  {agents.length > 4 && <span className="ck-proj-more">+{agents.length - 4}</span>}
                </span>
              )}
              {signal && <span className={`ck-proj-signal is-${signal}`}>{({ needs: t('sidebar.needsYou'), error: t('sidebar.error'), working: t('sidebar.working') })[signal]}</span>}
            </span>
          )}
          {folded && count > 0 && <span className={`ck-proj-count${needs ? ' is-needs' : ''}`}>{count}</span>}
        </button>
      )}
      {hasFolder && !renaming && (
        <>
          <button type="button" className="ck-proj-act" aria-label={t('sidebar.newAgentIn', { name })} title={t('sidebar.newAgentIn', { name })} onClick={onNewAgent}>
            <IconPlus />
          </button>
          <button
            type="button"
            ref={moreRef}
            className="ck-proj-act"
            aria-label={t('sidebar.moreFor', { name })}
            title={t('sidebar.more')}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (menu) setMenu(null);
              else openMenu(r.left, r.bottom + 4, true);
            }}
          >
            <IconMore />
          </button>
        </>
      )}
      {menu && (
        <Menu
          anchorRef={menu.fromMore ? moreRef : undefined}
          point={menu.fromMore ? undefined : { x: menu.x, y: menu.y }}
          align="start"
          className="ck-menu--compact"
          label={t('sidebar.more')}
          onClose={(back) => {
            setMenu(null);
            if (back) moreRef.current?.focus();
          }}
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
                {t('sidebar.rename')}
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
                {t('sidebar.removeFromSidebar')}
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
              {t('sidebar.addToSidebar')}
            </button>
          )}
        </Menu>
      )}
    </div>
  );
}
