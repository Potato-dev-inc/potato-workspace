// Settings > Phone > Telegram (early). Step 1 saves the bot token in the OS credential store; the app never
// shows it again, not even its last digits. Step 2 pairs one chat. Then the person turns the bot on and
// picks what it may do. Telegram is a third party, so the warning at the top always shows.
import { errorSentence } from '../../../lib/sayError';
import { en } from '../../../i18n/en';
import { t, useT } from '../../../i18n';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import {
  onTelegramChanged,
  telegramForget,
  telegramPairDecide,
  telegramPairStart,
  telegramSetEnabled,
  telegramSetOptions,
  telegramSetToken,
  telegramStatus,
  type TelegramCap,
  type TelegramStatus,
} from '../../../lib/telegram-api';
import type { SettingsEnv } from '../model';
import { Btn, FieldInput, Note, SettingBlock, SettingRow, SettingToggle } from '../settings-ui';
import { nameOf, TelegramPairing } from './TelegramPairing';

// The English wording is the catalog's (i18n/en/settingsTelegram.ts); these exports are what the tests compare against.
export const TELEGRAM_WARNING = en['telegram.warning'];
export const TELEGRAM_FOOTER = en['telegram.footer'];
export const TELEGRAM_AUDIT = en['telegram.audit'];
export const NO_STORE = en['telegram.noStore'];
export const DISCONNECT_BODY = en['telegram.disconnectBody'];

/** While the link is connecting or on, the block asks the PC again this often, in case an event was missed. */
export const STATUS_POLL_MS = 3000;

/** At this many strangers an hour the warning shows. */
export const STRANGERS_WARN_AT = 50;

/** What each capability lets the bot do. `control` is not offered: starting agents stays on this PC. */
export const TELEGRAM_CAPS: { cap: TelegramCap; label: string }[] = [
  { cap: 'watch', label: en['telegram.cap.watch'] },
  { cap: 'answer', label: en['telegram.cap.answer'] },
  { cap: 'type', label: en['telegram.cap.type'] },
];

export const ERROR_TEXT: Record<NonNullable<TelegramStatus['error']>, string> = {
  token_rejected: en['telegram.error.token_rejected'],
  conflict: en['telegram.error.conflict'],
  webhook_set: en['telegram.error.webhook_set'],
  blocked: en['telegram.error.blocked'],
  network: en['telegram.error.network'],
};

/** "12 s" or "3 min": how long ago the last check was. */
export function agoText(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return secs < 60 ? t('telegram.agoSecs', { n: secs }) : t('telegram.agoMins', { n: Math.floor(secs / 60) });
}

/** The one status line: the error sentence first, then the state. */
export function statusLine(s: TelegramStatus, now: number): string {
  if (s.error) return t(`telegram.error.${s.error}`);
  if (s.state === 'on') return s.lastPollAtMs == null ? t('telegram.on') : t('telegram.onLast', { ago: agoText(now - s.lastPollAtMs) });
  if (s.state === 'connecting') return t('telegram.connecting');
  if (s.state === 'error') return t('telegram.stopped');
  return t('telegram.off');
}

/** The seam the block talks through: the Tauri wrappers in production, a fake in tests. */
export interface TelegramApi {
  status: () => Promise<TelegramStatus>;
  setToken: (token: string) => Promise<TelegramStatus>;
  pairStart: () => Promise<TelegramStatus>;
  pairDecide: (accept: boolean) => Promise<TelegramStatus>;
  setEnabled: (on: boolean) => Promise<TelegramStatus>;
  setOptions: (caps: TelegramCap[], notifyRuns: boolean, shortMode: boolean) => Promise<TelegramStatus>;
  forget: () => Promise<TelegramStatus>;
  onChanged: (listener: () => void) => () => void;
}

export const telegramApi: TelegramApi = {
  status: telegramStatus,
  setToken: telegramSetToken,
  pairStart: telegramPairStart,
  pairDecide: telegramPairDecide,
  setEnabled: telegramSetEnabled,
  setOptions: (caps, notifyRuns, shortMode) => telegramSetOptions({ caps, notifyRuns, shortMode }),
  forget: telegramForget,
  // `onTelegramChanged` resolves to its unlisten function; the block wants a plain one, so wait for it.
  onChanged: (listener) => {
    const pending = onTelegramChanged(listener);
    return () => void pending.then((unlisten) => unlisten());
  },
};

const errText = (err: unknown): string => (errorSentence(err));

export function TelegramSetup({ env, api = telegramApi }: { env: SettingsEnv; api?: TelegramApi }) {
  const t = useT();
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());

  /** Reads the status again. The latest answer wins; an answer that arrives after unmount is dropped. */
  const load = useCallback(
    (alive: () => boolean) => {
      api
        .status()
        .then((next) => alive() && setStatus(next))
        .catch((err) => alive() && setError(errText(err)));
    },
    [api],
  );

  useEffect(() => {
    let live = true;
    const reload = () => load(() => live);
    reload();
    const off = api.onChanged(reload);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      off();
      clearInterval(clock);
    };
  }, [api, load]);

  // The event is the main way the line stays true; while it says "Connecting…" or "On" it is also read
  // every few seconds, so a conflict or a refused token shows up even if an event was missed.
  const linkState = status?.state;
  useEffect(() => {
    if (linkState !== 'connecting' && linkState !== 'on') return;
    let live = true;
    const poll = setInterval(() => load(() => live), STATUS_POLL_MS);
    return () => {
      live = false;
      clearInterval(poll);
    };
  }, [linkState, load]);

  /** Runs one change and shows what came back. A refusal stays on screen as the reason. */
  const change = async (action: () => Promise<TelegramStatus>, saved = true) => {
    setError(null);
    setBusy(true);
    try {
      setStatus(await action());
      if (saved) env.markSaved();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  // The token leaves the field the moment Check is pressed. It is never kept on screen.
  const check = () => {
    const token = draft.trim();
    setDraft('');
    if (token) void change(() => api.setToken(token));
  };

  const disconnect = async () => {
    const ok = await env.confirm({ title: t('telegram.disconnectTitle'), body: t('telegram.disconnectBody'), confirmLabel: t('telegram.disconnect') });
    if (ok) void change(() => api.forget());
  };

  const s = status;
  const saveOptions = (next: { caps?: TelegramCap[]; notifyRuns?: boolean; shortMode?: boolean }) => {
    if (!s) return;
    void change(() =>
      api.setOptions(next.caps ?? s.caps, next.notifyRuns ?? s.notifyRuns, next.shortMode ?? s.shortMode),
    );
  };
  const toggleCap = (cap: TelegramCap, on: boolean) => {
    if (!s) return;
    saveOptions({ caps: TELEGRAM_CAPS.map((c) => c.cap).filter((c) => (c === cap ? on : s.caps.includes(c))) });
  };

  return (
    <>
      <div className="st-tg-warn">{t('telegram.warning')}</div>
      {error && <Note role="alert">{error}</Note>}
      {s && (
        <>
          <SettingBlock label={t('telegram.step1')} description={t('telegram.step1Help')}>
            <div className="st-tg-token">
              <FieldInput
                aria-label={t('telegram.tokenAria')}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={!s.storeAvailable || busy}
                value={draft}
                placeholder={s.tokenSet ? t('telegram.tokenReplace') : t('telegram.tokenHere')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') check();
                }}
              />
              <Btn small disabled={!s.storeAvailable || busy || !draft.trim()} onClick={check}>
                {t('telegram.check')}
              </Btn>
            </div>
            {!s.storeAvailable ? (
              <Note role="alert">{t('telegram.noStore')}</Note>
            ) : (
              s.tokenSet && <Note role="status">{`${s.botUsername ? `@${s.botUsername} ✓` : t('telegram.tokenSaved')} · ${t('telegram.keptIn', { store: s.storeLabel })}`}</Note>
            )}
          </SettingBlock>

          {s.tokenSet && (
            <SettingBlock
              label={t('telegram.step2')}
              description={s.paired ? t('telegram.step2Paired') : t('telegram.step2Help')}
            >
              {s.paired ? (
                <Note role="status">{t('telegram.connectedTo', { name: nameOf(s.paired) })}</Note>
              ) : (
                <TelegramPairing
                  status={s}
                  now={now}
                  busy={busy}
                  onMakeCode={() => void change(() => api.pairStart(), false)}
                  onDecide={(accept) => void change(() => api.pairDecide(accept))}
                />
              )}
            </SettingBlock>
          )}

          {s.paired && (
            <>
              <SettingToggle
                label={t('telegram.onLabel')}
                description={statusLine(s, now)}
                checked={s.enabled}
                disabled={busy}
                onChange={(on) => void change(() => api.setEnabled(on))}
              />
              {s.strangersLastHour >= STRANGERS_WARN_AT && (
                <Note role="alert">{t('telegram.strangers')}</Note>
              )}
              <SettingBlock label={t('telegram.mayDo')} description={t('telegram.mayDoHelp')} />
              {TELEGRAM_CAPS.map(({ cap }) => (
                <SettingToggle
                  key={cap}
                  label={t(`telegram.cap.${cap}`)}
                  checked={s.caps.includes(cap)}
                  disabled={busy}
                  onChange={(on) => toggleCap(cap, on)}
                />
              ))}
              <SettingToggle
                label={t('telegram.notifyRuns')}
                description={t('telegram.notifyRunsHelp')}
                checked={s.notifyRuns}
                disabled={busy}
                onChange={(on) => saveOptions({ notifyRuns: on })}
              />
              <SettingToggle
                label={t('telegram.short')}
                description={t('telegram.shortHelp')}
                checked={s.shortMode}
                disabled={busy}
                onChange={(on) => saveOptions({ shortMode: on })}
              />
            </>
          )}

          {(s.tokenSet || s.paired) && (
            <SettingRow label={t('telegram.disconnect')} description={t('telegram.disconnectHelp')}>
              <Btn small disabled={busy} onClick={() => void disconnect()}>
                {t('telegram.disconnect')}
              </Btn>
            </SettingRow>
          )}
          <Note>{`${t('telegram.footer')} ${t('telegram.audit')}`}</Note>
        </>
      )}
    </>
  );
}
