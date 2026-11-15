// Outputs: the things the agent made in this chat that a person opens and reads (pages, notes, pictures, data, Word,
// Sheet, PDF). Source code and styles are changes, so they live in Changes. Three rows, then "Show N more".
import { useState } from 'react';
import { useT } from '../../../i18n';
import { openFileTab } from '../../../lib/file-tabs';
import type { OutputFile } from '../../../lib/sessionChatModel';
import { dragSourceProps } from '../../dnd/dragSourceProps';
import { FileGlyph } from './FileGlyph';
import { outputKind, type OutputKind } from './fileKind';
import { RailSection } from './RailSection';
import { baseName, relativeTo, writtenFiles } from './railFormat';

const SHOWN = 3;

export interface OutputRow {
  path: string;
  kind: OutputKind;
}

/** The files the agent wrote that are things to open (not code), newest last as the chat listed them. */
export function outputRows(outputs: readonly OutputFile[]): OutputRow[] {
  const rows: OutputRow[] = [];
  for (const f of writtenFiles(outputs)) {
    const kind = outputKind(f.path);
    if (kind) rows.push({ path: f.path, kind });
  }
  return rows;
}

export function OutputsSection({ paneId, cwd, outputs }: { paneId: string; cwd: string; outputs: readonly OutputFile[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const rows = outputRows(outputs);
  const shown = all ? rows : rows.slice(0, SHOWN);
  const hidden = rows.length - SHOWN;
  return (
    <RailSection id="out" title={t('rail.out.title')} summary={rows.length > 0 ? String(rows.length) : t('rail.out.summaryNone')}>
      {rows.length === 0 ? (
        <div className="rp-row is-empty">{t('rail.out.none')}</div>
      ) : (
        <>
          {shown.map((row) => (
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
          ))}
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
