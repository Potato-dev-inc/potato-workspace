// The card under the line for the picked point, in two columns: what its turn changed, and what going back
// to it would change now. A click on a file shows that file's patch (read only). "Go back to here" is one
// button for one project; when it cannot be used, the reason sits beside it in plain words.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { NowDiff, PointFile, PointRef, TimelineApi } from '../../lib/timeline';
import { AgentLogo } from '../common/AgentLogo';
import { FileDiff } from '../files/FileDiff';
import { backSummary } from './back-summary';
import { clock, type Mark } from './lanes-model';
import type { PointDetail } from './use-point-detail';
import type { Refusal } from './refusal';

type Say = ReturnType<typeof useT>;

export { backSummary };

const STATUS_KEY = { A: 'timeline.detail.statusA', M: 'timeline.detail.statusM', D: 'timeline.detail.statusD' } as const;

function FileRow({
  file,
  open,
  simple,
  onToggle,
  patch,
  t,
}: {
  file: PointFile;
  open: boolean;
  simple: boolean;
  onToggle: () => void;
  patch: { patch: string; truncated: boolean } | string | undefined;
  t: Say;
}) {
  const status = STATUS_KEY[file.status as keyof typeof STATUS_KEY];
  return (
    <li className="ck-tl-file">
      <button type="button" className="ck-tl-file-btn" aria-expanded={open} onClick={onToggle}>
        <span className="ck-tl-file-status" data-status={file.status} title={status ? t(status) : file.status}>
          {file.status}
        </span>
        <span className="ck-tl-file-path">{file.path}</span>
        {!simple && <span className="ck-tl-file-delta">{file.binary ? t('timeline.detail.binary') : `+${file.added} −${file.deleted}`}</span>}
      </button>
      {open && (
        <div className="ck-tl-patch">
          {patch === undefined ? (
            <p className="ck-sub">{t('timeline.detail.patchLoading')}</p>
          ) : typeof patch === 'string' ? (
            <p className="ck-sub">{patch}</p>
          ) : patch.patch === '' ? (
            <p className="ck-sub">{t('timeline.detail.patchEmpty')}</p>
          ) : (
            <>
              <FileDiff path={file.path} patch={patch.patch} canTell={false} onTell={() => undefined} />
              {patch.truncated && <p className="ck-sub">{t('timeline.detail.patchCut')}</p>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** One column's file list with the patch of the opened file. */
function Files({
  files,
  more,
  side,
  point,
  api,
  simple,
  t,
}: {
  files: PointFile[];
  more: number;
  side: 'turn' | 'now';
  point: PointRef;
  api: Pick<TimelineApi, 'filePatch'>;
  simple: boolean;
  t: Say;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [patches, setPatches] = useState<Record<string, { patch: string; truncated: boolean } | string>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const toggle = (path: string) => {
    if (openPath === path) return setOpenPath(null);
    setOpenPath(path);
    if (patches[path] !== undefined) return;
    api.filePatch(point, path, side).then(
      (p) => alive.current && setPatches((cur) => ({ ...cur, [path]: p })),
      (e) => alive.current && setPatches((cur) => ({ ...cur, [path]: errorSentence(e) })),
    );
  };
  return (
    <>
      <ul className="ck-tl-files">
        {files.map((f) => (
          <FileRow key={f.path} file={f} open={openPath === f.path} simple={simple} onToggle={() => toggle(f.path)} patch={patches[f.path]} t={t} />
        ))}
      </ul>
      {more > 0 && <p className="ck-sub">{t('timeline.detail.more', { n: more })}</p>}
    </>
  );
}

export function DetailCard({
  mark,
  laneName,
  point,
  detail,
  api,
  agentName,
  simple,
  refusal,
  busy,
  onGoBack,
}: {
  mark: Mark;
  laneName: string;
  point: PointRef;
  detail: PointDetail;
  api: Pick<TimelineApi, 'filePatch'>;
  agentName: string;
  simple: boolean;
  refusal: Refusal | null;
  busy: boolean;
  onGoBack: () => void;
}) {
  const t = useT();
  const { row } = mark;
  const turnFiles = Array.isArray(detail.turn) ? detail.turn : null;
  const title = simple && mark.shape !== 'undo' ? row.chatTitle || row.note : row.note || row.chatTitle;
  return (
    <section className="ck-tl-card" aria-label={t('timeline.detail.head', { time: clock(row.atMs), project: laneName })} data-testid="timeline-detail">
      <header className="ck-tl-card-head">
        <span className="ck-tl-card-time">{clock(row.atMs)}</span>
        <span className="ck-tl-card-project">{laneName}</span>
        {mark.shape !== 'undo' && row.agentType && (
          <span className="ck-tl-card-agent">
            <AgentLogo id={row.agentType} name={agentName} size={14} decorative />
            {agentName}
          </span>
        )}
        {title && <span className="ck-tl-card-note">“{title}”</span>}
        {!simple && mark.shape !== 'undo' && row.turn > 0 && !mark.helper && <span className="ck-tl-card-meta">{t('timeline.mark.turn', { n: row.turn })}</span>}
        {!simple && mark.shape !== 'undo' && (
          <span className="ck-tl-card-meta">
            {t('timeline.turnSum.files', { count: row.files })} +{row.added} −{row.deleted}
          </span>
        )}
      </header>
      {mark.shape === 'undo' && <p className="ck-sub">{t('timeline.detail.wentBack')}</p>}
      <div className="ck-tl-cols">
        <div className="ck-tl-col">
          <h3 className="ck-caption">{t('timeline.detail.turnTitle')}</h3>
          {detail.turn === undefined ? (
            <p className="ck-sub">{t('timeline.detail.loading')}</p>
          ) : typeof detail.turn === 'string' ? (
            <p className="ck-sub">{detail.turn}</p>
          ) : turnFiles && turnFiles.length === 0 ? (
            <p className="ck-sub">{t('timeline.detail.noChanges')}</p>
          ) : (
            turnFiles && <Files key={`turn|${mark.id}`} files={turnFiles} more={0} side="turn" point={point} api={api} simple={simple} t={t} />
          )}
        </div>
        <div className="ck-tl-col">
          <h3 className="ck-caption">{t('timeline.detail.backTitle')}</h3>
          {detail.back === undefined && !detail.backError ? (
            <p className="ck-sub" role="status">
              <span className="ck-tl-spin" aria-hidden="true" />
              {t('timeline.detail.loading')}
            </p>
          ) : detail.back ? (
            <>
              <p className="ck-tl-sum" data-testid="timeline-sum">
                {backSummary(detail.back, t)}
              </p>
              <Files key={`now|${mark.id}`} files={detail.back.files} more={detail.back.more} side="now" point={point} api={api} simple={simple} t={t} />
            </>
          ) : null}
          <div className="ck-tl-go">
            <button type="button" className="ck-btn ck-btn--primary" data-testid="timeline-go-back" disabled={refusal !== null || busy || detail.back === undefined} onClick={onGoBack}>
              {simple ? t('timeline.simple.goBack') : t('timeline.goBack')}
            </button>
            {refusal && (
              <span className="ck-tl-why" role="status">
                {t(`timeline.refuse.${refusal}` as const)}
              </span>
            )}
          </div>
          <p className="ck-sub ck-tl-memory">{t('timeline.sheet.body')}</p>
        </div>
      </div>
    </section>
  );
}
