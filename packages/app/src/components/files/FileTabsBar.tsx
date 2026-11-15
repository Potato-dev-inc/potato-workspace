// The files open beside the chat, as a row of small tabs under the pane's header. A file tab belongs to the pane's
// view only: it is not an agent, so closing it never touches the agent, and the phone never lists it.
import { closeFileTab, fileTabId } from '../../lib/file-tabs';
import { artifactIdOfPath, artifactTabTitle } from '../../lib/artifact-tabs';
import { useT } from '../../i18n';
import { isDirty, useDraftKeys } from '../../lib/file-drafts';
import { IconClose } from '../cockpit/Icons';
import '../../styles/files.css';

export function FileTabsBar({ paneId, files, active, onPick }: { paneId: string; files: readonly string[]; active: string; onPick: (tab: ReturnType<typeof fileTabId>) => void }) {
  const t = useT();
  const drafts = useDraftKeys();
  if (files.length === 0) return null;
  return (
    <div className="ck-ftabs" role="tablist" aria-label={t('files.tabsLabel')} data-testid="file-tabs">
      {files.map((path) => {
        const id = fileTabId(path);
        const isPage = artifactIdOfPath(path) !== null;
        const name = isPage ? artifactTabTitle(path) : path.slice(path.lastIndexOf('/') + 1);
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
              onAuxClick={(e) => {
                if (e.button === 1) close();
              }}
            >
              {unsaved && <span className="ck-ftab-dot" role="img" aria-label={t('files.unsaved')} />}
              {name}
            </button>
            <button type="button" className="ck-ftab-x" aria-label={t('files.closeFile', { name })} onClick={close}>
              <IconClose />
            </button>
          </div>
        );
      })}
    </div>
  );
}
