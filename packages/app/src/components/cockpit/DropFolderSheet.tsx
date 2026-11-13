// A folder dragged from Windows onto the sidebar: "Add as a project?" with the folder's name. Nothing is added until
// the person says yes. The hook watches the sidebar's rectangle (through the one window drop listener in lib/fileDrop);
// the sheet is the confirm. Esc or "Not now" closes it.
import { useEffect, useId, useState, type RefObject } from 'react';
import { useT } from '../../i18n';
import { folderName } from '../../lib/sidebarProjects';
import { isValidProjectPath } from '../../lib/project-path';
import { registerFileDrop } from '../../lib/fileDrop';
import { pathKinds } from '../../lib/dropFiles';
import { Sheet } from './Sheet';

export function useFolderDrop(
  host: RefObject<HTMLElement | null>,
  kindsOf: (paths: readonly string[]) => Promise<string[]> = pathKinds,
): { over: boolean; pending: string | null; clear: () => void } {
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const id = useId();
  useEffect(() => {
    let alive = true;
    const off = registerFileDrop({
      id: `sidebar-folder-${id}`,
      getRect: () => host.current?.getBoundingClientRect() ?? null,
      onOver: setOver,
      onDrop: (paths) => {
        void kindsOf(paths).then(
          (kinds) => {
            const folder = paths.find((p, i) => kinds[i] === 'dir' && isValidProjectPath(p));
            if (alive && folder) setPending(folder);
          },
          () => undefined,
        );
      },
    });
    return () => {
      alive = false;
      off();
    };
  }, [host, id, kindsOf]);
  return { over, pending, clear: () => setPending(null) };
}

export function DropFolderSheet({ path, onAdd, onClose }: { path: string; onAdd: (path: string) => void; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  return (
    <Sheet labelledBy={titleId} onClose={onClose} role="dialog">
      <h2 id={titleId} className="ck-section">
        {t('dnd.addProjectTitle')}
      </h2>
      <p className="ck-sub" title={path}>
        {t('dnd.addProjectBody', { name: folderName(path) })}
      </p>
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
          {t('dnd.notNow')}
        </button>
        <button
          type="button"
          className="ck-btn ck-btn--sm ck-btn--primary"
          autoFocus
          onClick={() => {
            onAdd(path);
            onClose();
          }}
        >
          {t('dnd.addProjectYes')}
        </button>
      </div>
    </Sheet>
  );
}
