// The two read-only questions about a picked point: what its turn changed, and what going back to it would
// change in the folder now. Both are asked only when a point is picked (no git runs before that).
import { useEffect, useState } from 'react';
import { errorSentence } from '../../lib/sayError';
import type { NowDiff, PointFile, PointRef, TimelineApi } from '../../lib/timeline';

export interface PointDetail {
  /** `undefined` = still loading. */
  turn: PointFile[] | string | undefined;
  back: NowDiff | undefined;
  /** The backend's sentence when the going-back question failed (it is also the reason a go back is refused). */
  backError: string | null;
}

const LOADING: PointDetail = { turn: undefined, back: undefined, backError: null };

export function usePointDetail(api: Pick<TimelineApi, 'pointDiff' | 'nowDiff'>, point: PointRef | null, reload = 0): PointDetail {
  const [detail, setDetail] = useState<PointDetail>(LOADING);
  const key = point ? `${point.project}|${point.key}|${point.id}` : '';
  useEffect(() => {
    if (!point) {
      setDetail(LOADING);
      return;
    }
    let live = true;
    setDetail(LOADING);
    api.pointDiff(point).then(
      (files) => live && setDetail((d) => ({ ...d, turn: files })),
      (e) => live && setDetail((d) => ({ ...d, turn: errorSentence(e) })),
    );
    api.nowDiff(point).then(
      (back) => live && setDetail((d) => ({ ...d, back, backError: null })),
      (e) => live && setDetail((d) => ({ ...d, back: undefined, backError: errorSentence(e) })),
    );
    return () => {
      live = false;
    };
    // `point` is rebuilt on every render: its three fields (`key`) are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, reload]);
  return detail;
}
