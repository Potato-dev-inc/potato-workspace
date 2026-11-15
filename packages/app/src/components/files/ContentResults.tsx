// The lines "Search inside files" found, grouped by file, the words marked. A click opens the file at that line.
import { Fragment } from 'react';
import type { ContentHit } from '../../lib/files-api';
import { useT } from '../../i18n';
import { FileGlyph } from '../cockpit/rail/FileGlyph';

/** The line split into before / match / after, by characters (not UTF-16 units). */
export function splitHit(text: string, start: number, end: number): [string, string, string] {
  const chars = [...text];
  const a = Math.max(0, Math.min(start, chars.length));
  const b = Math.max(a, Math.min(end, chars.length));
  return [chars.slice(0, a).join(''), chars.slice(a, b).join(''), chars.slice(b).join('')];
}

export function ContentResults({ hits, truncated, onOpen }: { hits: readonly ContentHit[]; truncated: boolean; onOpen: (hit: ContentHit) => void }) {
  const t = useT();
  return (
    <>
      <ul className="ck-ftree ck-fsearch" aria-label={t('files.searchResults')} data-testid="files-content-hits">
        {hits.map((hit, ix) => {
          const [before, match, after] = splitHit(hit.text, hit.start, hit.end);
          const newFile = ix === 0 || hits[ix - 1].path !== hit.path;
          return (
            <Fragment key={`${hit.path}:${hit.line}`}>
              {newFile && (
                <li className="ck-fsearch-file" role="presentation" title={hit.path}>
                  <FileGlyph name={hit.name} />
                  <span className="ck-ftree-name">{hit.name}</span>
                  <span className="ck-ftree-dir">{hit.path.includes('/') ? hit.path.slice(0, hit.path.lastIndexOf('/')) : ''}</span>
                </li>
              )}
              <li>
                <button
                  type="button"
                  className="ck-ftree-row ck-fsearch-line"
                  aria-label={t('files.searchHit', { name: hit.name, line: hit.line, text: hit.text })}
                  data-testid="files-content-hit"
                  onClick={() => onOpen(hit)}
                >
                  <span className="ck-fsearch-no" aria-hidden="true">
                    {hit.line}
                  </span>
                  <span className="ck-fsearch-text" aria-hidden="true">
                    {before}
                    <mark>{match}</mark>
                    {after}
                  </span>
                </button>
              </li>
            </Fragment>
          );
        })}
      </ul>
      {truncated && <p className="ck-rail-more">{t('files.searchMore', { count: hits.length })}</p>}
    </>
  );
}
