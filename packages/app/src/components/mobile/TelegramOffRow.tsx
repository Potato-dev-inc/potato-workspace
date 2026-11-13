// "Turn Telegram off" row of the phone menu sheet. The phone can only switch Telegram OFF
// (bridge POST /channels/telegram/off). Turning it on, pairing and every other setting stay on the PC.
// The row shows only while the PC says Telegram is on, so a phone with no paired chat never sees it.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { getTelegramPhoneStatus, turnTelegramOff } from '../../lib/telegram-bridge';

export interface TelegramOffDeps {
  /** GET /channels/telegram. Only `on` matters here: it is false until the chat is paired and turned on. */
  status: () => Promise<{ on: boolean }>;
  /** POST /channels/telegram/off. */
  turnOff: () => Promise<void>;
}

/** Real calls to the paired phone's bridge, through `lib/telegram-bridge.ts`. */
export function browserTelegramDeps(baseUrl: string): TelegramOffDeps {
  return {
    status: () => getTelegramPhoneStatus(baseUrl),
    turnOff: async () => {
      await turnTelegramOff(baseUrl);
    },
  };
}

export function TelegramOffRow({
  baseUrl,
  bridgeReady,
  deps: injected,
}: {
  baseUrl: string;
  bridgeReady: boolean;
  /** Tests inject fakes. */
  deps?: TelegramOffDeps;
}) {
  const t = useT();
  const deps = useMemo(() => injected ?? browserTelegramDeps(baseUrl), [injected, baseUrl]);
  // What the PC last said: true only when Telegram is on. A failed read counts as off (row hidden).
  const [on, setOn] = useState(false);
  // This phone switched it off in this session.
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!bridgeReady) return;
    let live = true;
    deps
      .status()
      .then((s) => live && setOn(s.on === true))
      .catch(() => live && setOn(false));
    return () => {
      live = false;
    };
  }, [deps, bridgeReady]);

  if (!on && !done) return null;

  const turnOff = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await deps.turnOff();
      setDone(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="ph-group">
        <div className="ph-switch-row">
          <span className="ph-rowtext">{done ? t('phone.telegram.off') : t('phone.telegram.on')}</span>
        </div>
        {!done && (
          <button
            type="button"
            disabled={!bridgeReady || busy}
            onClick={() => void turnOff()}
            className="ph-rowbtn ph-rowbtn--strong"
            style={{ borderTop: '1px solid var(--sep)' }}
          >
            {t('phone.telegram.turnOff')}
          </button>
        )}
      </div>
      {done && <p className="ph-foot">{t('phone.telegram.offNote')}</p>}
      {failed && (
        <p role="alert" className="ph-foot ph-foot--err">
          {t('phone.telegram.failed')}
        </p>
      )}
    </>
  );
}
