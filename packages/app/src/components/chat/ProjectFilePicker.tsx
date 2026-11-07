import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createProjectFileSearcher, PROJECT_FILE_LIMIT, type ProjectFileHit, type ProjectFileSearcher } from '../../lib/projectFiles';
import '../../styles/project-file-picker.css';

export const PROJECT_FILE_DEBOUNCE_MS = 120;

/** The part of a keyboard event the picker reads, so the composer can forward its own events. */
export interface ProjectFilePickerKeyEvent {
  key: string;
  preventDefault(): void;
}

export interface ProjectFilePickerHandle {
  /** Returns true when the picker consumed the key (the caller should stop handling it). */
  handleKey(e: ProjectFilePickerKeyEvent): boolean;
}

export interface ProjectFilePickerProps {
  paneId: string;
  query: string;
  open: boolean;
  anchorRect?: DOMRect | null;
  onPick(file: ProjectFileHit): void;
  onClose(): void;
}

/**
 * Finds an `@word` being typed at the caret. The `@` must start the text or follow whitespace,
 * and the query may not contain whitespace. `a@b` is not a mention.
 */
export function findMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const end = Math.max(0, Math.min(caret, text.length));
  let i = end - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') break;
    if (/\s/.test(ch)) return null;
    i--;
  }
  if (i < 0) return null;
  if (i > 0 && !/\s/.test(text[i - 1])) return null;
  return { start: i, query: text.slice(i + 1, end) };
}

/** Removes the `@query` text (from `start` up to the caret) after a file was picked. */
export function removeMention(text: string, start: number, caret: number): string {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(caret, text.length));
  return text.slice(0, from) + text.slice(to);
}

function FileIcon() {
  return (
    <svg className="ck-pfp-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

/** Bolds the first case-insensitive match of `query` inside `name`. */
function renderName(name: string, query: string): ReactNode {
  const q = query.toLowerCase();
  const idx = q ? name.toLowerCase().indexOf(q) : -1;
  if (idx < 0) return name;
  return (
    <>
      {name.slice(0, idx)}
      <strong>{name.slice(idx, idx + query.length)}</strong>
      {name.slice(idx + query.length)}
    </>
  );
}

function folderOf(path: string, name: string): string {
  const dir = path.endsWith(name) ? path.slice(0, path.length - name.length) : path;
  return dir.replace(/\/$/, '');
}

/**
 * Floating list of project files for the `@` mention. Keys are forwarded through the ref's
 * `handleKey`, so the composer keeps focus in its text area.
 */
export const ProjectFilePicker = forwardRef<ProjectFilePickerHandle, ProjectFilePickerProps>(function ProjectFilePicker(props, ref) {
  const { paneId, query, open, anchorRect, onPick, onClose } = props;
  const [state, setState] = useState<{ results: ProjectFileHit[]; loading: boolean }>({ results: [], loading: true });
  const [active, setActive] = useState(0);
  const searcherRef = useRef<ProjectFileSearcher | null>(null);
  if (searcherRef.current === null) searcherRef.current = createProjectFileSearcher();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const searcher = searcherRef.current!;
    if (!open) {
      searcher.cancel();
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      searcher.search(paneId, query, PROJECT_FILE_LIMIT).then((hits) => {
        if (cancelled || hits === null) return;
        setState({ results: hits, loading: false });
        setActive(0);
      });
    }, PROJECT_FILE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      searcher.cancel();
    };
  }, [open, paneId, query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const { results, loading } = state;
  const index = Math.min(active, Math.max(results.length - 1, 0));

  const handleKey = (e: ProjectFilePickerKeyEvent): boolean => {
    if (!open) return false;
    const n = results.length;
    switch (e.key) {
      case 'ArrowDown':
        if (n === 0) return false;
        e.preventDefault();
        setActive((i) => (Math.min(i, n - 1) + 1) % n);
        return true;
      case 'ArrowUp':
        if (n === 0) return false;
        e.preventDefault();
        setActive((i) => (Math.min(i, n - 1) - 1 + n) % n);
        return true;
      case 'Enter':
      case 'Tab': {
        const hit = results[index];
        if (!hit) return false;
        e.preventDefault();
        onPick(hit);
        return true;
      }
      case 'Escape':
        e.preventDefault();
        onClose();
        return true;
      default:
        return false;
    }
  };

  useImperativeHandle(ref, () => ({ handleKey }));

  if (!open) return null;

  const floating = anchorRect
    ? {
        left: anchorRect.left,
        bottom: window.innerHeight - anchorRect.top + 8,
        width: Math.min(Math.max(anchorRect.width, 280), 480),
      }
    : undefined;
  const style: CSSProperties | undefined = floating;
  const showLoading = loading && results.length === 0;
  const showEmpty = !loading && results.length === 0;

  return (
    <div
      className={`ck-pfp${anchorRect ? ' ck-pfp--fixed' : ''}`}
      style={style}
      data-testid="project-file-picker"
    >
      {results.length > 0 && (
        <div ref={listRef} className="ck-pfp-list" role="listbox" aria-label="Project files" id="ck-pfp-listbox">
          {results.map((hit, i) => {
            const selected = i === index;
            return (
              <div
                key={hit.absPath}
                id={`ck-pfp-option-${i}`}
                role="option"
                aria-selected={selected}
                title={hit.path}
                className="ck-pfp-row"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(hit)}
              >
                <FileIcon />
                <span className="ck-pfp-text">
                  <span className="ck-pfp-name">{renderName(hit.name, query)}</span>
                  <span className="ck-pfp-dir">{folderOf(hit.path, hit.name)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {showLoading && (
        <div className="ck-pfp-status" role="status">Searching…</div>
      )}
      {showEmpty && (
        <div className="ck-pfp-status" role="status">No matching files</div>
      )}
    </div>
  );
});

export type { ProjectFileHit } from '../../lib/projectFiles';
