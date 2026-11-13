// "<phone> asks for control": a small notice on the PC when a phone whose agent is watch-only (or switched off) asks to type for a while.
// Allow 15 min lets that agent take the phone's typing for 15 minutes and then puts the old rule back; No changes nothing. Nothing
// is allowed unless a person here taps it. One notice at a time; the next waits behind it.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { tauri } from '../../lib/tauri';
import type { ControlAsk } from '../../lib/pane-remote';
import '../../styles/control-ask.css';

export function ControlAskNotice({ names }: { names: Map<string, string> }) {
  const t = useT();
  const [asks, setAsks] = useState<ControlAsk[]>([]);

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    // Asks made before this window opened, then the ones that come.
    void tauri.listControlAsks().then((list) => live && setAsks((cur) => mergeAsks(cur, list)));
    void tauri.onControlAsk((ask) => live && setAsks((cur) => mergeAsks(cur, [ask]))).then((unlisten) => {
      if (live) off = unlisten;
      else unlisten();
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const answer = useCallback((ask: ControlAsk, allow: boolean) => {
    setAsks((cur) => cur.filter((a) => a.id !== ask.id));
    void tauri.answerControlAsk(ask.id, allow).catch(() => undefined);
  }, []);

  const ask = asks[0];
  if (!ask) return null;
  const agent = names.get(ask.pane_id) ?? t('phone.pill.someone');
  return (
    <div className="ck-ctlask" role="alertdialog" aria-label={t('phone.deskAsk.title', { device: ask.device_name })} data-testid="control-ask-notice">
      <p className="ck-ctlask-title">{t('phone.deskAsk.title', { device: ask.device_name })}</p>
      <p className="ck-ctlask-body">{t('phone.deskAsk.body', { agent })}</p>
      <div className="ck-ctlask-actions">
        <button type="button" onClick={() => answer(ask, false)} autoFocus>
          {t('phone.deskAsk.no')}
        </button>
        <button type="button" className="ck-ctlask-yes" onClick={() => answer(ask, true)}>
          {t('phone.deskAsk.allow')}
        </button>
      </div>
    </div>
  );
}

function mergeAsks(cur: ControlAsk[], more: ControlAsk[]): ControlAsk[] {
  const known = new Set(cur.map((a) => a.id));
  const fresh = more.filter((a) => !known.has(a.id));
  return fresh.length === 0 ? cur : [...cur, ...fresh];
}
