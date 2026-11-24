// Outputs: the things the agent made in this chat that a person opens and reads (pages, notes, pictures, data, Word,
// Sheet, PDF). Source code and styles are changes, so they live in Changes. Three rows, then "Show N more".
import { useState } from 'react';
import { useT } from '../../../i18n';
import { useHost } from '../../../lib/host/context';
import { openFileTab } from '../../../lib/file-tabs';
import type { OutputFile } from '../../../lib/sessionChatModel';
import { dragSourceProps } from '../../dnd/dragSourceProps';
import { FileGlyph } from './FileGlyph';
import { outputKind, type OutputKind } from './fileKind';
import { removeGone, useGoneFiles } from '../../../lib/gone-files';
import { isPutBack, useReviewMarks } from '../../../lib/turn-review';
import { RailSection } from './RailSection';
import { baseName, insideProject, relativeTo, writtenFiles } from './railFormat';

const SHOWN = 3;

export interface OutputRow {
  path: string;
  at?: string | null;
  kind: OutputKind;
}

/** The files the agent wrote that are things to open (not code), newest last as the chat listed them. */
export function outputRows(outputs: readonly OutputFile[]): OutputRow[] {
  const rows: OutputRow[] = [];
  for (const f of writtenFiles(outputs)) {
    const kind = outputKind(f.path);
    if (kind) rows.push({ path: f.path, kind, at: f.at });
  }
  return rows;
}

export function OutputsSection({ paneId, cwd, outputs }: { paneId: string; cwd: string; outputs: readonly OutputFile[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  // A chat of another PC names paths of that PC's folders: only this PC's own chats are checked against the project folder.
  const local = useHost().place.kind === 'local';
  useReviewMarks();
  const goneOf = useGoneFiles();
  // A file the person put back is gone (or as it was): the chat's past write events still name it.
  // Files outside the project (an agent's own notes folder) are not this project's outputs.
  const rows = outputRows(outputs.filter((o) => !local || insideProject(cwd, o.path))).filter((r) => !isPutBack(paneId, relativeTo(cwd, r.path), r.at ?? null) && goneOf(paneId, relativeTo(cwd, r.path)) !== 'hidden');
  const shown = all ? rows : rows.slice(0, SHOWN);
  const hidden = rows.length - SHOWN;
  return (
    <RailSection id="out" title={t('rail.out.title')} summary={rows.length > 0 ? String(rows.length) : t('rail.out.summaryNone')}>
      {rows.length === 0 ? (
        <div className="rp-row is-empty">{t('rail.out.none')}</div>
      ) : (
        <>
          {shown.map((row) =>
            goneOf(paneId, relativeTo(cwd, row.path)) === 'gone' ? (
              <div key={row.path} className="rp-row" title={row.path}>
                <FileGlyph name={row.path} />
                <span className="rp-name" style={{ textDecoration: 'line-through' }}>{baseName(row.path)}</span>
                <span className="rp-v is-dim">{t('rail.out.gone')}</span>
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => removeGone(paneId, relativeTo(cwd, row.path))}>
                  {t('rail.out.remove')}
                </button>
              </div>
            ) : (
              <button
                key={row.path}
                type="button"
                className="rp-row rp-btn"
                title={row.path}
                onClick={() => openFileTab(paneId, relativeTo(cwd, row.path))}
                {...dragSourceProps({ kind: 'file', id: row.path, label: baseName(row.path), meta: { abs: row.path } })}
              >
                <FileGlyph name={row.path} />
                <span className="rp-name">{baseName(row.path)}</span>
                <span className="rp-v is-dim">{t(`rail.out.kind.${row.kind}` as 'rail.out.kind.page')}</span>
              </button>
            ),
          )}
          {hidden > 0 && (
            <button type="button" className="rp-row rp-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? t('rail.out.less') : t('rail.out.more', { n: hidden })}
            </button>
          )}
        </>
      )}
    </RailSection>
  );
}
