// The editing state of one file tab: when the editor is open, what the person has typed, what the file held when the
// edit started, save, revert, and the "changed on disk" case. The unsaved text is kept in `lib/file-drafts`, so it
// survives switching to another tab. The text the editor shows is its own while it is open (see CodeEdit).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileContent, FilesApi } from '../../lib/files-api';
import { clearDraft, getDraft, setDraft } from '../../lib/file-drafts';
import { sayError } from '../../lib/sayError';
import { useT } from '../../i18n';

/** Line ends as the editor sees them: one `\n` for every kind. */
export const normalise = (text: string): string => text.replace(/\r\n?/g, '\n');

/** The editor's text as the file wants it: a file that used Windows line ends keeps them. */
export const toDisk = (text: string, crlf: boolean): string => (crlf ? normalise(text).replace(/\n/g, '\r\n') : normalise(text));

const isConflict = (err: unknown): boolean => sayError(err).details.includes('Code: FILES_CONFLICT');

interface Base {
  text: string;
  version: string;
}

export interface FileEdit {
  editing: boolean;
  /** The text has been changed and not saved. */
  dirty: boolean;
  /** The file changed on disk while there were unsaved changes (or the save found it so). */
  conflict: boolean;
  saving: boolean;
  /** What the editor shows when it starts, and the number that makes it start over. */
  initial: string;
  revision: number;
  start(): void;
  /** Leaves the editor. Only when nothing is unsaved. */
  stop(): void;
  onChange(text: string): void;
  save(): void;
  revert(): void;
  /** The conflict answers. */
  reload(): void;
  keepMine(): void;
}

export function useFileEdit({
  api,
  paneId,
  path,
  content,
  setContent,
  onNotice,
}: {
  api: FilesApi;
  paneId: string;
  path: string;
  content: FileContent | null;
  setContent: (c: FileContent) => void;
  onNotice: (text: string | null) => void;
}): FileEdit {
  const t = useT();
  // A draft left by an earlier visit to this tab brings the editor back as it was.
  const [stored] = useState(() => getDraft(paneId, path));
  const [editing, setEditing] = useState(!!stored);
  const [base, setBase] = useState<Base | null>(stored ? { text: stored.baseText, version: stored.baseVersion } : null);
  const [current, setCurrent] = useState<string | null>(stored ? stored.text : null);
  const [initial, setInitial] = useState(stored ? stored.text : '');
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const baseRef = useRef(base);
  baseRef.current = base;
  const currentRef = useRef(current);
  currentRef.current = current;
  const crlf = useRef(!!base && base.text.includes('\r\n'));
  // The version a save replaced: a read that began before the save must not take the file back to it.
  const superseded = useRef<string | null>(null);

  const dirty = current !== null && !!base && normalise(current) !== normalise(base.text);

  const restart = useCallback((next: Base, text?: string) => {
    crlf.current = next.text.includes('\r\n');
    setBase(next);
    setCurrent(null);
    setInitial(normalise(text ?? next.text));
    setRevision((r) => r + 1);
    setConflict(false);
    clearDraft(paneId, path);
  }, [paneId, path]);

  const start = useCallback(() => {
    if (!content || content.kind !== 'text') return;
    restart({ text: content.text ?? '', version: content.version ?? '' });
    setEditing(true);
  }, [content, restart]);

  const stop = useCallback(() => {
    if (currentRef.current !== null && baseRef.current && normalise(currentRef.current) !== normalise(baseRef.current.text)) return;
    clearDraft(paneId, path);
    setCurrent(null);
    setConflict(false);
    setEditing(false);
  }, [paneId, path]);

  const onChange = useCallback(
    (text: string) => {
      setCurrent(text);
      const b = baseRef.current;
      if (!b) return;
      if (normalise(text) === normalise(b.text)) clearDraft(paneId, path);
      else setDraft(paneId, path, { text, baseText: b.text, baseVersion: b.version });
    },
    [paneId, path],
  );

  // The file was read again (the agent may have changed it): follow it, or flag a clash with the unsaved text.
  useEffect(() => {
    if (!editing || !base || !content || content.kind !== 'text' || !content.version) return;
    if (content.version === superseded.current) return;
    superseded.current = null;
    if (content.version === base.version) {
      setConflict(false);
      return;
    }
    if (!dirty) restart({ text: content.text ?? '', version: content.version });
    else setConflict(true);
  }, [content]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new read of the file counts

  const doSave = useCallback(
    async (overwrite: boolean) => {
      const b = baseRef.current;
      const text = currentRef.current;
      if (!b || text === null) return;
      setSaving(true);
      const onDisk = toDisk(text, crlf.current);
      try {
        const done = await api.write(paneId, path, onDisk, b.version, overwrite);
        superseded.current = b.version;
        setBase({ text: onDisk, version: done.version });
        setCurrent(null);
        setInitial(normalise(text));
        setConflict(false);
        clearDraft(paneId, path);
        setContent({ path, name: content?.name ?? path, kind: 'text', text: onDisk, size: done.size, version: done.version });
        onNotice(t('files.saved'));
      } catch (err) {
        if (isConflict(err)) setConflict(true);
        else onNotice(sayError(err).text);
      } finally {
        setSaving(false);
      }
    },
    [api, paneId, path, content?.name, setContent, onNotice, t],
  );

  const save = useCallback(() => {
    const text = currentRef.current;
    const b = baseRef.current;
    if (text === null || !b || normalise(text) === normalise(b.text)) return;
    void doSave(false);
  }, [doSave]);

  const reload = useCallback(() => {
    api.read(paneId, path).then(
      (fresh) => {
        if (fresh.kind !== 'text') return onNotice(t('files.binary'));
        setContent(fresh);
        restart({ text: fresh.text ?? '', version: fresh.version ?? '' });
      },
      (err: unknown) => onNotice(sayError(err).text),
    );
  }, [api, paneId, path, restart, setContent, onNotice, t]);

  const revert = useCallback(() => {
    if (conflict) return reload();
    const b = baseRef.current;
    if (b) restart(b);
  }, [conflict, reload, restart]);

  const keepMine = useCallback(() => void doSave(true), [doSave]);

  return { editing, dirty, conflict, saving, initial: current ?? initial, revision, start, stop, onChange, save, revert, reload, keepMine };
}
