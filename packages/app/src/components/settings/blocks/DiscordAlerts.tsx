// Settings > General > Discord alerts: paste a Discord webhook link, press Test, choose which alerts to post.
// The link is kept in the secure store on this PC. After it is saved the field shows only a mask: the link never
// comes back to this window. No bot. Off until a link is saved.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import {
  discordErrorMessage,
  tauriDiscordAlertsApi,
  type DiscordAlertsApi,
  type DiscordAlertsStatus,
  type DiscordKinds,
} from '../../../lib/discordAlerts';
import { SendTest } from '../previews/Previews';
import { Btn, FieldInput, Note, SettingBlock, SettingToggle } from '../settings-ui';

const MASK = '\u2022'.repeat(24);

export function DiscordAlertsBlock({ api = tauriDiscordAlertsApi, onSaved }: { api?: DiscordAlertsApi; onSaved?: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<DiscordAlertsStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .status()
      .then((s) => live && setStatus(s))
      .catch(() => {
        /* not the desktop app: the block stays empty */
      });
    return () => {
      live = false;
    };
  }, [api]);

  if (!status) return null;

  const run = async (work: () => Promise<DiscordAlertsStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await work());
      onSaved?.();
      return true;
    } catch (e) {
      setError(discordErrorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const link = draft.trim();
    if (!link) return;
    if (await run(() => api.setUrl(link))) setDraft('');
  };

  const remove = async () => {
    await run(() => api.clear());
    setDraft('');
  };

  const setKind = (key: keyof DiscordKinds, value: boolean) => {
    void run(() => api.setKinds({ ...status.kinds, [key]: value }));
  };

  return (
    <>
      <SettingBlock
        label={t('discord.link')}
        description={t('discord.linkHelp')}
      >
        <div className="flex flex-wrap items-center gap-2">
          {status.saved ? (
            <FieldInput
              aria-label={t('discord.linkAria')}
              type="password"
              readOnly
              value={MASK}
              title={status.tail ? t('discord.savedEnds', { tail: status.tail }) : t('settings.saved')}
            />
          ) : (
            <FieldInput
              aria-label={t('discord.linkAria')}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://discord.com/api/webhooks/..." // i18n-ok: example
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
            />
          )}
          {!status.saved && (
            <Btn primary disabled={busy || draft.trim() === ''} onClick={() => void save()}>
              {t('discord.save')}
            </Btn>
          )}
          <SendTest
            disabledReason={status.saved ? (busy ? t('discord.working') : null) : t('discord.addFirst')}
            send={() => api.test()}
          />
          {status.saved && (
            <Btn disabled={busy} onClick={() => void remove()}>
              {t('settings.remove')}
            </Btn>
          )}
        </div>
        {status.saved && <Note role="status">{t('discord.savedNote', { tail: status.tail ?? '...' })}</Note>}
        {!status.saved && <Note>{t('discord.notOn')}</Note>}
        {error && <Note role="alert">{error}</Note>}
      </SettingBlock>
      <SettingToggle
        label={t('discord.needsYou')}
        description={t('discord.needsYouHelp')}
        checked={status.kinds.needs_you}
        onChange={(value) => setKind('needs_you', value)}
      />
      <SettingToggle
        label={t('discord.finished')}
        description={t('discord.finishedHelp')}
        checked={status.kinds.finished}
        onChange={(value) => setKind('finished', value)}
      />
      <SettingToggle
        label={t('discord.failed')}
        description={t('discord.failedHelp')}
        checked={status.kinds.failed}
        onChange={(value) => setKind('failed', value)}
      />
    </>
  );
}
