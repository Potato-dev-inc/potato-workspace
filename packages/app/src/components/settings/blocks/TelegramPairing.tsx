// Settings > Phone > Telegram, step 2: a one-time code the person sends to their bot, then the desktop
// "Is this you?" card. Both the code and the click are needed, so a stranger who guesses the code still
// cannot pair without the person saying yes here. Plain content only: the step's label comes from the caller.
import type { TelegramStatus } from '../../../lib/telegram-api';
import { t, useT } from '../../../i18n';
import { Btn, Note } from '../settings-ui';

/** "9:30": the time left on the code, rounded up so it never shows 0:00 while the code still works. */
export function countdownText(expiresAtMs: number, now: number): string {
  const secs = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** "Anna (@anna_k)", or "someone" when Telegram sent no name. */
export function nameOf(who: { username: string | null; firstName: string | null }): string {
  const name = who.firstName?.trim() || t('telegram.someone');
  return who.username ? `${name} (@${who.username})` : name;
}

export function TelegramPairing({
  status,
  now,
  busy,
  onMakeCode,
  onDecide,
}: {
  status: TelegramStatus;
  now: number;
  busy: boolean;
  onMakeCode: () => void;
  onDecide: (accept: boolean) => void;
}) {
  const t = useT();
  const pairing = status.pairing;

  // Someone sent the code: the desktop asks first. Nothing pairs without this click.
  if (pairing?.waitingFor) {
    return (
      <div className="st-tg-pair">
        <p className="st-tg-ask">
          {t('telegram.isThisYou')} <span>{t('telegram.whoTelegram', { name: nameOf(pairing.waitingFor) })}</span>
        </p>
        <div className="st-tg-decide">
          <Btn primary small disabled={busy} onClick={() => onDecide(true)}>
            {t('telegram.yesMe')}
          </Btn>
          <Btn small disabled={busy} onClick={() => onDecide(false)}>
            {t('telegram.notMe')}
          </Btn>
        </div>
      </div>
    );
  }

  // No code yet, or the code ran out: make a new one.
  if (!pairing || now >= pairing.expiresAtMs) {
    return (
      <div className="st-tg-pair">
        {pairing ? (
          <Note role="status">{t('telegram.codeRanOut')}</Note>
        ) : (
          <Note>{t('telegram.codeHelp')}</Note>
        )}
        <div>
          <Btn primary small disabled={busy || !status.tokenSet} onClick={onMakeCode}>
            {pairing ? t('telegram.newCode') : t('telegram.makeCode')}
          </Btn>
        </div>
      </div>
    );
  }

  // The code is live: send it to the bot in a private chat.
  const bot = status.botUsername ? `@${status.botUsername}` : t('telegram.yourBot');
  return (
    <div className="st-tg-pair">
      <div className="st-tg-code" aria-label={t('phone.code')}>
        {pairing.code}
      </div>
      <Note>
        {t('telegram.sendStart', { code: pairing.code, bot, time: countdownText(pairing.expiresAtMs, now) })}
      </Note>
      <Note role="status">{t('telegram.waiting')}</Note>
    </div>
  );
}
