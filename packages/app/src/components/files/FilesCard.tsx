// The "Files" card in the right panel: the project folder as a tree. Folders open when you click them (the folder is
// read then, not before), changed and new files carry a small letter, a filter box finds a file by name anywhere in
// the project, a click opens the file in a tab, and a right-click (or the menu key) offers Copy path, Show in
// Explorer and Mention in chat. The project folder is the pane's folder: the backend refuses anything outside it.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { filesApi, type FileMark, type FilesApi, type FolderListing } from '../../lib/files-api';
import { searchProjectFiles, type ProjectFileHit } from '../../lib/projectFiles';
import { openFileTab } from '../../lib/file-tabs';
import { pushComposerInsert } from '../../lib/composer-insert';
import { requestChatTab } from '../../lib/chatTab';
import { errorSentence } from '../../lib/sayError';
import { useT } from '../../i18n';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { EditorMenuItems } from './OpenInEditor';
import { RailCard } from '../cockpit/rail/RailCard';
import { baseOf, fileMark, folderHasChanges, visibleRows, type Mark } from './tree-model';
import '../../styles/files.css';

const SEARCH_MS = 150;
const SEARCH_LIMIT = 50;

export interface FilesCardProps {
  paneId: string;
  /** The pane's project folder, for "Copy path". */
  cwd: string;
  /** The pane has a chat box to mention a file in (a plain shell has none). */
  canMention?: boolean;
  /** Changes when the agent may have touched files (its status): the marks and the opened folders are read again. */
  refreshKey?: string;
  api?: FilesApi;
  search?: (paneId: string, query: string, limit?: number) => Promise<ProjectFileHit[]>;
}

/** A path in the style of the project folder: `C:\work` + `src/a.ts` = `C:\work\src\a.ts`. */
export function absolutePath(cwd: string, rel: string): string {
  const sep = cwd.includes('\\') ? '\\' : '/';
  const base = cwd.replace(/[\\/]+$/, '');
  return `${base}${sep}${sep === '\\' ? rel.replace(/\//g, '\\') : rel}`;
}

interface MenuAt {
  path: string;
  isDir: boolean;
  anchor: HTMLElement;
}

export function FilesCard({ paneId, cwd, canMention = true, refreshKey = '', api = filesApi, search = searchProjectFiles }: FilesCardProps) {
  const t = useT();
  const [listings, setListings] = useState<Record<string, FolderListing | undefined>>({});
  const [failed, setFailed] = useState<Record<string, string | undefined>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [marks, setMarks] = useState<readonly FileMark[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProjectFileHit[] | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const load = useCallback(
    (folder: string) => {
      api.list(paneId, folder).then(
        (listing) => {
          setListings((cur) => ({ ...cur, [folder]: listing }));
          setFailed((cur) => ({ ...cur, [folder]: undefined }));
        },
        (err: unknown) => setFailed((cur) => ({ ...cur, [folder]: errorSentence(err) })),
      );
    },
    [api, paneId],
  );

  // The top folder when the card shows, and again with everything that is open whenever the agent may have changed files.
  useEffect(() => {
    load('');
    for (const folder of openRef.current) load(folder);
    let cancelled = false;
    api.marks(paneId).then(
      (m) => !cancelled && setMarks(m),
      () => !cancelled && setMarks([]),
    );
    return () => {
      cancelled = true;
    };
  }, [api, paneId, refreshKey, load]);

  // The filter finds files anywhere in the project by name (the same search the @ picker uses).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(paneId, q, SEARCH_LIMIT).then(
        (found) => !cancelled && setHits(found),
        () => !cancelled && setHits([]),
      );
    }, SEARCH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, paneId, search]);

  const toggle = (path: string) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!listings[path]) load(path);
  };

  const rows = useMemo(() => visibleRows('', 0, listings, open), [listings, open]);
  const focusRow = (path: string) => {
    const el = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find((e) => e.dataset.path === path);
    el?.focus();
  };
  const [roving, setRoving] = useState<string | null>(null);
  const stop = roving && rows.some((r) => r.entry.path === roving) ? roving : rows[0]?.entry.path;

  const onRowKey = (e: KeyboardEvent<HTMLElement>, ix: number) => {
    const row = rows[ix];
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      setMenu({ path: row.entry.path, isDir: row.entry.isDir, anchor: e.currentTarget });
      return;
    }
    let target: string | undefined;
    if (e.key === 'ArrowDown') target = rows[ix + 1]?.entry.path;
    else if (e.key === 'ArrowUp') target = rows[ix - 1]?.entry.path;
    else if (e.key === 'Home') target = rows[0]?.entry.path;
    else if (e.key === 'End') target = rows[rows.length - 1]?.entry.path;
    else if (e.key === 'ArrowRight' && row.entry.isDir) {
      if (!row.open) toggle(row.entry.path);
      else target = rows[ix + 1]?.entry.path;
    } else if (e.key === 'ArrowLeft') {
      if (row.entry.isDir && row.open) toggle(row.entry.path);
      else {
        const parent = row.entry.path.includes('/') ? row.entry.path.slice(0, row.entry.path.lastIndexOf('/')) : null;
        if (parent !== null) target = parent;
      }
    } else return;
    e.preventDefault();
    if (target) {
      setRoving(target);
      focusRow(target);
    }
  };

  const openMenu = (e: MouseEvent<HTMLElement>, path: string, isDir: boolean) => {
    e.preventDefault();
    setMenu({ path, isDir, anchor: e.currentTarget });
  };

  const say = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 2500);
  };
  const copyPath = (path: string) => {
    const full = absolutePath(cwd, path);
    if (!navigator.clipboard) return say(t('files.copyFailed'));
    navigator.clipboard.writeText(full).then(
      () => say(t('files.copied')),
      () => say(t('files.copyFailed')),
    );
  };
  const mention = (path: string, isDir: boolean) => {
    pushComposerInsert(paneId, `@${path}${isDir ? '/' : ''} `);
    requestChatTab(paneId);
  };
  const reveal = (path: string) => {
    api.reveal(paneId, path).catch((err: unknown) => say(errorSentence(err)));
  };

  const markFor = (path: string): Mark | null => fileMark(path, marks);
  const markLabel = (m: Mark) => (m === 'N' ? t('files.markNew') : t('files.markChanged'));

  const rootFailed = failed[''];
  const rootLoaded = listings[''];
  const filtering = query.trim() !== '';

  return (
    <RailCard title={t('files.title')} testId="rail-files">
      <input
        type="search"
        className="ck-ftree-filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('files.filter')}
        aria-label={t('files.filterLabel')}
        data-testid="files-filter"
      />
      {notice && (
        <p className="ck-rail-line" role="status">
          {notice}
        </p>
      )}
      {filtering ? (
        hits === null ? (
          <p className="ck-rail-empty">{t('files.loading')}</p>
        ) : hits.length === 0 ? (
          <p className="ck-rail-empty">{t('files.noMatch')}</p>
        ) : (
          <ul className="ck-ftree" aria-label={t('files.results')} data-testid="files-hits">
            {hits.map((hit) => {
              const mark = markFor(hit.path);
              return (
                <li key={hit.path}>
                  <button
                    type="button"
                    className="ck-ftree-row ck-ftree-hit"
                    title={hit.path}
                    onClick={() => openFileTab(paneId, hit.path)}
                    onContextMenu={(e) => openMenu(e, hit.path, false)}
                  >
                    <span className="ck-ftree-name">{hit.name}</span>
                    <span className="ck-ftree-dir">{hit.path.includes('/') ? hit.path.slice(0, hit.path.lastIndexOf('/')) : ''}</span>
                    {mark && (
                      <span className="ck-ftree-mark" data-mark={mark} role="img" aria-label={markLabel(mark)}>
                        {mark}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : rootFailed ? (
        <p className="ck-rail-empty" role="alert">
          {rootFailed}
        </p>
      ) : !rootLoaded ? (
        <p className="ck-rail-empty">{t('files.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="ck-rail-empty">{t('files.empty')}</p>
      ) : (
        <ul className="ck-ftree" role="tree" aria-label={t('files.treeLabel')} ref={treeRef} data-testid="files-tree">
          {rows.map((row, ix) => {
            const { entry } = row;
            const mark = entry.isDir ? null : markFor(entry.path);
            const dirty = entry.isDir && folderHasChanges(entry.path, marks);
            const inner = failed[entry.path];
            return (
              <li key={entry.path} role="none">
                <button
                  type="button"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={entry.isDir ? row.open : undefined}
                  className={`ck-ftree-row${entry.isDir ? ' is-dir' : ''}`}
                  style={{ paddingLeft: 6 + row.depth * 12 }}
                  tabIndex={entry.path === stop ? 0 : -1}
                  data-path={entry.path}
                  title={entry.path}
                  onFocus={() => setRoving(entry.path)}
                  onClick={() => (entry.isDir ? toggle(entry.path) : openFileTab(paneId, entry.path))}
                  onContextMenu={(e) => openMenu(e, entry.path, entry.isDir)}
                  onKeyDown={(e) => onRowKey(e, ix)}
                >
                  <span className="ck-ftree-twist" aria-hidden="true">
                    {entry.isDir ? (row.open ? '▾' : '▸') : ''}
                  </span>
                  <span className="ck-ftree-name">{entry.name}</span>
                  {dirty && <span className="ck-ftree-dot" role="img" aria-label={t('files.hasChanges')} />}
                  {mark && (
                    <span className="ck-ftree-mark" data-mark={mark} role="img" aria-label={markLabel(mark)}>
                      {mark}
                    </span>
                  )}
                  {inner && <span className="ck-ftree-dir">{t('files.folderFailed')}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!filtering && rootLoaded?.truncated && <p className="ck-rail-more">{t('files.truncated')}</p>}
      {menu && (
        <FloatingMenu
          anchorRef={{ current: menu.anchor }}
          align="start"
          label={baseOf(menu.path)}
          onClose={(back) => {
            setMenu(null);
            if (back) focusRow(menu.path);
          }}
        >
          {!menu.isDir && (
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item"
              onClick={() => {
                setMenu(null);
                openFileTab(paneId, menu.path);
              }}
            >
              {t('files.menuOpen')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="ck-menu-item"
            onClick={() => {
              setMenu(null);
              copyPath(menu.path);
            }}
          >
            {t('files.menuCopy')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ck-menu-item"
            onClick={() => {
              setMenu(null);
              reveal(menu.path);
            }}
          >
            {t('files.menuReveal')}
          </button>
          {!menu.isDir && <EditorMenuItems paneId={paneId} path={menu.path} onDone={() => setMenu(null)} onFail={say} />}
          {canMention && (
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item"
              onClick={() => {
                setMenu(null);
                mention(menu.path, menu.isDir);
              }}
            >
              {t('files.menuMention')}
            </button>
          )}
        </FloatingMenu>
      )}
    </RailCard>
  );
}
