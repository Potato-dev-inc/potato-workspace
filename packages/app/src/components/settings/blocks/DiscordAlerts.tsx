// Settings > General > Discord alerts: paste a Discord webhook link, press Test, choose which alerts to post.
// The link is kept in the secure store on this PC. After it is saved the field shows only a mask: the link never
// comes back to this window. No bot. Off until a link is saved.
import { useEffect, useState } from 'react';
import {
  discordErrorMessage,
  tauriDiscordAlertsApi,
  type DiscordAlertsApi,
  type DiscordAlertsStatus,
  type DiscordKinds,
} from '../../../lib/discordAlerts';
import { Btn, FieldInput, Note, SettingBlock, SettingToggle } from '../settings-ui';

const MASK = '\u2022'.repeat(24);

export function DiscordAlertsBlock({ api = tauriDiscordAlertsApi, onSaved }: { api?: DiscordAlertsApi; onSaved?: () => void }) {
  const [status, setStatus] = useState<DiscordAlertsStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

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
    setResult(null);
    if (await run(() => api.setUrl(link))) setDraft('');
  };

  const remove = async () => {
    setResult(null);
    await run(() => api.clear());
    setDraft('');
  };

  const setKind = (key: keyof DiscordKinds, value: boolean) => {
    void run(() => api.setKinds({ ...status.kinds, [key]: value }));
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.test());
    } catch (e) {
      setResult({ ok: false, message: discordErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingBlock
        label="Webhook link"
        description="Kept in the secure store on this PC. After you save it, it is never shown again."
      >
        <div className="flex flex-wrap items-center gap-2">
          {status.saved ? (
            <FieldInput
              aria-label="Discord webhook link"
              type="password"
              readOnly
              value={MASK}
              title={status.tail ? `Saved. Ends in ${status.tail}` : 'Saved'}
            />
          ) : (
            <FieldInput
              aria-label="Discord webhook link"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://discord.com/api/webhooks/..."
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
              Save
            </Btn>
          )}
          <Btn disabled={busy || !status.saved} onClick={() => void test()}>
            Test
          </Btn>
          {status.saved && (
            <Btn disabled={busy} onClick={() => void remove()}>
              Remove
            </Btn>
          )}
        </div>
        {status.saved && <Note role="status">{`Saved in the secure store on this PC. Ends in ${status.tail ?? '...'}.`}</Note>}
        {!status.saved && <Note>Not on yet. In Discord: channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL.</Note>}
        {result && <Note role={result.ok ? 'status' : 'alert'}>{result.message}</Note>}
        {error && <Note role="alert">{error}</Note>}
      </SettingBlock>
      <SettingToggle
        label="Needs you"
        description="An agent asks a question or waits for you to allow something."
        checked={status.kinds.needs_you}
        onChange={(value) => setKind('needs_you', value)}
      />
      <SettingToggle
        label="Finished"
        description="An agent finishes its run."
        checked={status.kinds.finished}
        onChange={(value) => setKind('finished', value)}
      />
      <SettingToggle
        label="Failed"
        description="An agent run fails."
        checked={status.kinds.failed}
        onChange={(value) => setKind('failed', value)}
      />
    </>
  );
}
