// The files open beside the chat, as a row of small tabs under the pane's header. The first tab is the agent itself
// (its icon and name, pinned: it cannot be closed); it is the way back to the chat, as are Ctrl+1 and Esc (PaneView).
// A file tab belongs to the pane's view only: it is not an agent, so closing it never touches the agent, and the phone
// never lists it.
import { useState, type MouseEvent } from 'react';
import { closeFileTab, fileTabId } from '../../lib/file-tabs';
import { openChatInWindow, openFileInWindow, useChatInWindow } from '../../lib/tab-windows';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { artifactIdOfPath, artifactTabTitle } from '../../lib/artifact-tabs';
import { isGuidePath } from '../../lib/guide-tabs';
import { useT } from '../../i18n';
import { isDirty, useDraftKeys } from '../../lib/file-drafts';
import { AgentLogo } from '../common/AgentLogo';
import { FileGlyph } from '../cockpit/rail/FileGlyph';
import { IconClose } from '../cockpit/Icons';
import '../../styles/files.css';

export interface PinnedAgentTab {
  agentId: string;
  name: string;
  /** The pane's own view (the chat) is in front, not a file. */
  active: boolean;
  onPick: () => void;
}

interface TabMenu {
  /** `chat` for the pinned agent tab, else the file's path. */
  path: string | null;
  anchor: HTMLElement;
}

export function FileTabsBar({ paneId, files, active, onPick, agent }: { paneId: string; files: readonly string[]; active: string; onPick: (tab: ReturnType<typeof fileTabId>) => void; /** The pinned first tab. Absent: files only. */ agent?: PinnedAgentTab }) {
  const t = useT();
  const drafts = useDraftKeys();
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const chatOut = useChatInWindow(paneId);
  const [notice, setNotice] = useState<string | null>(null);
  if (files.length === 0) return null;
  const openMenu = (e: MouseEvent<HTMLElement>, path: string | null) => {
    e.preventDefault();
    setMenu({ path, anchor: e.currentTarget });
  };
  const fail = () => {
    setNotice(t('tabwin.failed'));
    window.setTimeout(() => setNotice(null), 3000);
  };
  return (
    <div className="ck-ftabs" role="tablist" aria-label={t('files.tabsLabel')} data-testid="file-tabs">
      {agent && (
        <div className={`ck-ftab ck-ftab--agent${agent.active ? ' is-active' : ''}`} data-testid="file-tab-agent">
          <button type="button" role="tab" aria-selected={agent.active} className="ck-ftab-main" title={t('files.agentTabTip', { name: agent.name })} onClick={agent.onPick} onContextMenu={(e) => openMenu(e, null)}>
            <AgentLogo id={agent.agentId} name={agent.name} size={13} decorative />
            <span className="ck-ftab-name">{agent.name}</span>
          </button>
        </div>
      )}
      {files.map((path) => {
        const id = fileTabId(path);
        const isGuide = isGuidePath(path);
        const isPage = isGuide || artifactIdOfPath(path) !== null;
        const name = isGuide ? t('guide.tabTitle') : isPage ? artifactTabTitle(path) : path.slice(path.lastIndexOf('/') + 1);
        const on = id === active;
        const unsaved = isDirty(drafts, paneId, path);
        const close = () => {
          if (unsaved && !window.confirm(t('files.discardAsk', { name }))) return;
          closeFileTab(paneId, path);
        };
        return (
          <div key={path} className={`ck-ftab${on ? ' is-active' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={on}
              className="ck-ftab-main"
              title={isPage ? name : path}
              onClick={() => onPick(id)}
              onContextMenu={isPage ? undefined : (e) => openMenu(e, path)}
              onAuxClick={(e) => {
                if (e.button === 1) close();
              }}
            >
              {!isPage && <FileGlyph name={name} />}
              {unsaved && <span className="ck-ftab-dot" role="img" aria-label={t('files.unsaved')} />}
              {name}
            </button>
            <button type="button" className="ck-ftab-x" aria-label={t('files.closeFile', { name })} onClick={close}>
              <IconClose />
            </button>
          </div>
        );
      })}
      {notice && (
        <span className="ck-ftab-note" role="status">
          {notice}
        </span>
      )}
      {menu && (
        <FloatingMenu anchorRef={{ current: menu.anchor }} align="start" label={t('tabwin.menuLabel')} onClose={() => setMenu(null)}>
          {menu.path === null ? (
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item"
              disabled={chatOut}
              data-testid="tab-menu-window"
              onClick={() => {
                setMenu(null);
                openChatInWindow(paneId, agent?.name ?? '').catch(fail);
              }}
            >
              {t('tabwin.openChat')}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item"
              disabled={isDirty(drafts, paneId, menu.path)}
              title={isDirty(drafts, paneId, menu.path) ? t('tabwin.saveFirst') : undefined}
              data-testid="tab-menu-window"
              onClick={() => {
                const path = menu.path!;
                setMenu(null);
                openFileInWindow(paneId, path, path.slice(path.lastIndexOf('/') + 1)).catch(fail);
              }}
            >
              {t('tabwin.openFile')}
            </button>
          )}
        </FloatingMenu>
      )}
    </div>
  );
}
