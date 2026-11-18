// "<PC> asks to work on this PC": the real card behind "Ask <PC> to allow agents" on another PC. It appears on THIS PC's window when a
// paired PC that may already look in (Watch or Answer) asks for the one switch "Can work on this PC (start agents, use the terminal,
// change files)". Nothing is granted unless a person here taps Allow; "Not now" changes nothing. One card at a time; the next waits
// behind it. The question is held in memory by this app, so a card that nobody answered is gone when the app closes.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { HoldButton, HOLD_MS } from '../chat/HoldButton';
import { clipText, devicesApi, type DevicesApi, type FullAsk } from '../../lib/devices';
import '../../styles/control-ask.css';

function merge(cur: FullAsk[], more: FullAsk[]): FullAsk[] {
  const known = new Set(cur.map((a) => a.id));
  const fresh = more.filter((a) => !known.has(a.id));
  return fresh.length === 0 ? cur : [...cur, ...fresh];
}

export function FullAskNotice({ api = devicesApi, holdMs = HOLD_MS }: { api?: DevicesApi; holdMs?: number }) {
  const t = useT();
  const [asks, setAsks] = useState<FullAsk[]>([]);

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    // Questions asked before this window opened, then the ones that come. (A PC with Devices off answers nothing: no card.)
    void api.fullAsks().then(
      (list) => live && Array.isArray(list) && setAsks((cur) => merge(cur, list)),
      () => undefined,
    );
    void api.onFullAsk((ask) => live && setAsks((cur) => merge(cur, [ask]))).then((unlisten) => {
      if (live) off = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      off?.();
    };
  }, [api]);

  const answer = useCallback(
    (ask: FullAsk, allow: boolean) => {
      setAsks((cur) => cur.filter((a) => a.id !== ask.id));
      void api.answerFullAsk(ask.id, allow).catch(() => undefined);
    },
    [api],
  );

  const ask = asks[0];
  if (!ask) return null;
  const name = clipText(ask.name, 40);
  return (
    <div className="ck-ctlask" role="alertdialog" aria-label={t('devices.fullAsk.title', { name })} data-testid="full-ask-notice">
      <p className="ck-ctlask-title">{t('devices.fullAsk.title', { name })}</p>
      <p className="ck-ctlask-body">{t('devices.fullAsk.body', { name })}</p>
      <div className="ck-ctlask-actions">
        <button type="button" onClick={() => answer(ask, false)} autoFocus data-testid="full-ask-no">
          {t('devices.fullAsk.no')}
        </button>
        {/* Allow is the one switch that lets another PC work here: it is held, not clicked (like a mode with no questions). */}
        <HoldButton className="ck-ctlask-yes" holdMs={holdMs} label={t('devices.fullAsk.holdLabel', { name })} onDone={() => answer(ask, true)}>
          <span data-testid="full-ask-allow">{t('devices.fullAsk.allow')}</span>
        </HoldButton>
      </div>
    </div>
  );
}
