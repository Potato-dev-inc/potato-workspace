// The "Files" card in the right panel: the project folder as a tree. Folders open when you click them (the folder is
// read then, not before), changed and new files carry a small letter, a filter box finds a file by name anywhere in
// the project, a click opens the file in a tab, and a right-click (or the menu key) offers Copy path, Show in
// Explorer and Mention in chat. The project folder is the pane's folder: the backend refuses anything outside it.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { filesApiFor, OnOtherPc, type ContentHit, type ContentSearch, type FileMark, type FilesApi, type FolderListing } from '../../lib/files-api';
import { clearContentSearchRequest, usePendingContentSearch } from '../../lib/files-search-request';
import { ContentResults } from './ContentResults';
import { CopyPathButton } from './CopyPathButton';
import { searchProjectFilesOn, type ProjectFileHit } from '../../lib/projectFiles';
import { openFileTab } from '../../lib/file-tabs';
import { pushComposerInsert } from '../../lib/composer-insert';
import { requestChatTab } from '../../lib/chatTab';
import { errorSentence } from '../../lib/sayError';
import { useT } from '../../i18n';
import { useHost } from '../../lib/host/context';
import { ruleError, tauriAgentRulesApi, type AgentRulesApi } from '../../lib/agentRules';
import { projectOfCwd } from '../../lib/ship-model';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { EditorMenuItems } from './OpenInEditor';
import { RailSection } from '../cockpit/rail/RailSection';
import { EmptyState } from '../common/EmptyState';
import { setRailSectionClosed } from '../cockpit/rail/railFold';
import { FileGlyph } from '../cockpit/rail/FileGlyph';
import { baseOf, capRows, fileMark, folderHasChanges, TREE_ROWS_STEP, visibleRows, type Mark } from './tree-model';
import '../../styles/files.css';

const SEARCH_MS = 150;
const SEARCH_LIMIT = 50;
/** Searching inside files starts at this many characters (one letter would match nearly every line). */
const CONTENT_MIN_CHARS = 2;
const CONTENT_MS = 300;

type SearchMode = 'names' | 'inside';

/** How often the shown card reads its folders again. */
/** Re-read cadence: quick while the agent works (it is changing files), slow when idle (a far PC pays a call for each). */
const REREAD_WORKING_MS = 5000;
const REREAD_IDLE_MS = 15_000;

export interface FilesCardProps {
  paneId: string;
  /** The pane's project folder, for "Copy path". */
  cwd: string;
  /** The pane has a chat box to mention a file in (a plain shell has none). */
  canMention?: boolean;
  /** Changes when the agent may have touched files (its status): the marks and the opened folders are read again. */
  refreshKey?: string;
  api?: FilesApi;
  /** "Fence this folder": where the fence is saved. */
  rules?: Pick<AgentRulesApi, 'fenceAdd'>;
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

export function FilesCard({ paneId, cwd, canMention = true, refreshKey = '', api: given, rules = tauriAgentRulesApi, search: givenSearch }: FilesCardProps) {
  const t = useT();
  const host = useHost();
  // Show in Explorer and Fence start things on THIS PC: they have no meaning for a file on another PC.
  const far = host.place.kind !== 'local';
  const api = useMemo(() => given ?? filesApiFor(host), [given, host]);
  const search = useMemo(() => givenSearch ?? searchProjectFilesOn(host), [givenSearch, host]);
  const [listings, setListings] = useState<Record<string, FolderListing | undefined>>({});
  const [failed, setFailed] = useState<Record<string, string | undefined>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [marks, setMarks] = useState<readonly FileMark[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProjectFileHit[] | null>(null);
  const [mode, setMode] = useState<SearchMode>('names');
  const [found, setFound] = useState<ContentSearch | 'failed' | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A folder on another PC cannot be shown here: the note says so, and offers the path to copy.
  const [farNote, setFarNote] = useState<{ text: string; path: string } | null>(null);
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

  // Files change outside the chat too (deleted in Explorer, made by a build): read again when the window gets focus back and every few seconds while shown.
  const [seen, setSeen] = useState(0);
  // Not asked while the section is folded (its filter box is not drawn) or scrolled out of view (no IntersectionObserver: always shown).
  const onScreen = useRef(true);
  useEffect(() => {
    const el = filterRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => entries.forEach((e) => (onScreen.current = e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const working = refreshKey.startsWith('running|');
  useEffect(() => {
    const again = () => document.visibilityState !== 'hidden' && filterRef.current !== null && onScreen.current && setSeen((n) => n + 1);
    window.addEventListener('focus', again);
    const timer = window.setInterval(again, working ? REREAD_WORKING_MS : REREAD_IDLE_MS);
    return () => {
      window.removeEventListener('focus', again);
      window.clearInterval(timer);
    };
  }, [working]);

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
  }, [api, paneId, refreshKey, seen, load]);

  // The filter finds files anywhere in the project by name (the same search the @ picker uses).
  useEffect(() => {
    const q = query.trim();
    if (!q || mode !== 'names') {
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
  }, [query, paneId, search, mode]);

  // "Inside files": the words are looked for in the project's files, off the screen's thread (the backend stops an older
  // search when a newer one starts, and this one when the card goes away).
  const searchId = `files-${paneId}`;
  useEffect(() => {
    const q = query.trim();
    setFound(null);
    if (mode !== 'inside' || [...q].length < CONTENT_MIN_CHARS) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.searchContents(paneId, q, searchId).then(
        (res) => !cancelled && setFound(res),
        () => !cancelled && setFound('failed'),
      );
    }, CONTENT_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void api.cancelSearch(searchId).catch(() => undefined);
    };
  }, [api, paneId, query, mode, searchId]);

  // The palette's "Search in files": switch to this box and put the cursor in it.
  const asked = usePendingContentSearch();
  useEffect(() => {
    if (!asked || asked.paneId !== paneId) return;
    setRailSectionClosed('files', false);
    setMode('inside');
    // The box may only be there after the section unfolds.
    window.setTimeout(() => {
      filterRef.current?.focus();
      filterRef.current?.select();
    }, 0);
    clearContentSearchRequest(asked);
  }, [asked, paneId]);

  const openHit = (hit: ContentHit) => openFileTab(paneId, hit.path, hit.line);

  const toggle = (path: string) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!listings[path]) load(path);
  };

  const allRows = useMemo(() => visibleRows('', 0, listings, open), [listings, open]);
  const [limit, setLimit] = useState(TREE_ROWS_STEP);
  const rows = useMemo(() => capRows(allRows, limit), [allRows, limit]);
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

  // The fence belongs to the project (a pane that works on a copy is fenced by its project).
  const fence = (path: string) => {
    const project = projectOfCwd(cwd)?.path ?? cwd;
    const name = baseOf(path);
    rules.fenceAdd(project, absolutePath(cwd, path)).then(
      () => say(t('files.fenced', { name })),
      (err: unknown) => say(t('files.fenceFailed', { name, why: ruleError(err) })),
    );
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
    api.reveal(paneId, path).catch((err: unknown) => {
      const text = errorSentence(err);
      // This note stays until the next one, so Copy path can be clicked; any other fades.
      if (err instanceof OnOtherPc) {
        setNotice(text);
        setFarNote({ text, path: err.path });
      } else say(text);
    });
  };

  const markFor = (path: string): Mark | null => fileMark(path, marks);
  const markLabel = (m: Mark) => (m === 'N' ? t('files.markNew') : t('files.markChanged'));

  const rootFailed = failed[''];
  const rootLoaded = listings[''];
  const filtering = query.trim() !== '';

  return (
    <RailSection id="files" title={t('files.title')} summary={rootLoaded ? `${baseOf(cwd)} · ${rootLoaded.entries.length}` : baseOf(cwd)} testId="rail-files">
      <input
        ref={filterRef}
        type="search"
        className="ck-ftree-filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={mode === 'inside' ? t('files.searchPlaceholder') : t('files.filter')}
        aria-label={mode === 'inside' ? t('files.searchLabel') : t('files.filterLabel')}
        data-testid="files-filter"
      />
      <div className="ck-fsearch-modes" role="group" aria-label={t('files.searchModeLabel')}>
        {(['names', 'inside'] as const).map((m) => (
          <button key={m} type="button" className="ck-fsearch-mode" aria-pressed={mode === m} data-testid={`files-mode-${m}`} title={m === 'names' ? t('files.searchNamesTip') : t('files.searchInsideTip')} onClick={() => setMode(m)}>
            {m === 'names' ? t('files.searchNames') : t('files.searchInside')}
          </button>
        ))}
      </div>
      {!filtering && open.size > 0 && (
        <button type="button" className="ck-ftree-collapse" data-testid="files-collapse-all" onClick={() => setOpen(new Set())}>
          {t('files.collapseAll')}
        </button>
      )}
      {notice && (
        <p className="ck-rail-line" role="status">
          {notice}
          {farNote && farNote.path && farNote.text === notice && <CopyPathButton path={farNote.path} onDone={say} />}
        </p>
      )}
      {filtering && mode === 'inside' ? (
        [...query.trim()].length < CONTENT_MIN_CHARS ? null : found === null ? (
          <p className="ck-rail-empty" role="status">
            {t('files.searching')}
          </p>
        ) : found === 'failed' ? (
          <p className="ck-rail-empty" role="alert">
            {t('files.searchFailed')}
          </p>
        ) : found.hits.length === 0 ? (
          <p className="ck-rail-empty">{t('files.searchNone')}</p>
        ) : (
          <ContentResults hits={found.hits} truncated={found.truncated} onOpen={openHit} />
        )
      ) : filtering ? (
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
                    <FileGlyph name={hit.name} />
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
        <EmptyState
          testId="files-empty"
          className="ck-empty--rail"
          title={t('files.emptyTitle')}
          line={t('files.emptyLine')}
          action={{ label: t('files.showInFolder'), onClick: () => reveal('') }}
        />
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
                  <FileGlyph name={entry.name} dir={entry.isDir} open={row.open} />
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
      {!filtering && allRows.length > rows.length && (
        <>
          <p className="ck-rail-more" data-testid="files-showing">
            {t('r15far.files.showing', { shown: rows.length, total: allRows.length })}
          </p>
          <button type="button" className="ck-btn ck-btn--plain" onClick={() => setLimit((n) => n + TREE_ROWS_STEP)}>
            {t('files.showMore', { count: allRows.length - rows.length })}
          </button>
        </>
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
          {!far && (
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
          )}
          {!menu.isDir && <EditorMenuItems paneId={paneId} path={menu.path} onDone={() => setMenu(null)} onFail={say} />}
          {!far && (
            <button
              type="button"
              role="menuitem"
              className="ck-menu-item"
              data-testid="menu-fence"
              onClick={() => {
                setMenu(null);
                fence(menu.path);
              }}
            >
              {menu.isDir ? t('files.fenceFolder') : t('files.fenceFile')}
            </button>
          )}
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
    </RailSection>
  );
}
