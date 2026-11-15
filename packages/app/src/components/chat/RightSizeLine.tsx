// One quiet line after a turn: "This looked small. Try Haiku next time? · Switch · Don't suggest". It appears only when
// the app worked it out on this PC (`acp::chat::right_size`), at most once per chat per day, and never while a turn runs.
// "Switch" changes the chat's model for the next turns; "Don't suggest" turns the suggestions off (Settings).
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { tauri, type RightSizeSuggestion } from '../../lib/tauri';
import { patchSettings } from '../../lib/settings';

export function RightSizeLine({ paneId, signal, running }: { paneId: string; signal?: string | number; running?: boolean }) {
  const tr = useT();
  const [pending, setPending] = useState<RightSizeSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (running) {
      setPending(null);
    } else {
      tauri.rightSizePending(paneId).then(
        (next) => alive.current && setPending(next),
        () => alive.current && setPending(null),
      );
    }
    return () => {
      alive.current = false;
    };
  }, [paneId, signal, running]);

  if (!pending && !note) return null;

  const switchModel = () => {
    if (busy) return;
    setBusy(true);
    tauri
      .rightSizeSwitch(paneId)
      .then((done) => {
        if (!alive.current) return;
        setPending(null);
        setNote(tr('rightSize.switched', { model: done.model }));
      })
      .catch(() => alive.current && setNote(tr('rightSize.failed')))
      .finally(() => alive.current && setBusy(false));
  };

  const stop = () => {
    setPending(null);
    setNote(null);
    void tauri.rightSizeDismiss(paneId);
    void patchSettings({ right_size_suggest: false });
  };

  return (
    <div className="ck-right-size" data-testid="right-size-line">
      {pending ? (
        <>
          <span>
            {pending.kind === 'smaller'
              ? tr('rightSize.smaller', { model: pending.toName })
              : tr('rightSize.stronger', { from: pending.fromName, model: pending.toName })}
          </span>
          <span aria-hidden="true"> · </span>
          <button type="button" className="ck-chat-link" data-right-size-action="switch" disabled={busy} onClick={switchModel}>
            {busy ? tr('rightSize.switching') : tr('rightSize.switch')}
          </button>
          <span aria-hidden="true"> · </span>
          <button type="button" className="ck-chat-link" data-right-size-action="stop" onClick={stop}>
            {tr('rightSize.stop')}
          </button>
        </>
      ) : (
        <span role="status">{note}</span>
      )}
    </div>
  );
}
