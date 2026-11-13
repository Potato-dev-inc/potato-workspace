// Settings > General: the search index of your chats (Ctrl+Shift+F). A switch to keep it or not, what it holds,
// and a button that clears it. Clearing asks first and never touches the chats themselves.
import { errorSentence } from '../../../lib/sayError';
import { en } from '../../../i18n/en';
import { useT } from '../../../i18n';
import { useEffect, useState } from 'react';
import { chatIndexClear, chatIndexSetEnabled, chatIndexStatus, indexStatusText, type ChatIndexStatus } from '../../../lib/chatIndex';
import { bindingLabel } from '../../../lib/shortcuts';
import type { SettingsEnv } from '../model';
import { Btn, SettingRow, SettingToggle } from '../settings-ui';

export const CHAT_INDEX_CLEAR_BODY = en['chatIndex.clearBody'];

export function ChatIndexSettings({ env }: { env: SettingsEnv }) {
  const t = useT();
  const [status, setStatus] = useState<ChatIndexStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void chatIndexStatus()
      .then((next) => live && setStatus(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // The switch shows what the app holds (on by default, until the first answer).
  const enabled = status?.enabled ?? true;

  const toggle = async (value: boolean) => {
    env.setError(null);
    try {
      setStatus(await chatIndexSetEnabled(value));
      env.markSaved();
    } catch (error) {
      env.setError(errorSentence(error));
    }
  };

  const clear = async () => {
    env.setError(null);
    const ok = await env.confirm({ title: t('chatIndex.clearTitle'), body: t('chatIndex.clearBody'), confirmLabel: t('chatIndex.clear') });
    if (!ok) return;
    setBusy(true);
    try {
      setStatus(await chatIndexClear());
      env.markSaved();
    } catch (error) {
      env.setError(errorSentence(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingToggle
        label={t('chatIndex.keep')}
        description={t('chatIndex.keepHelp', { keys: bindingLabel('search-chats') || t('chatIndex.chatSearch') })}
        checked={enabled}
        onChange={(value) => void toggle(value)}
      />
      <SettingRow label={t('chatIndex.clearLabel')} description={status ? indexStatusText(status) : t('teamPage.loading')}>
        <Btn disabled={busy || !status} onClick={() => void clear()}>
          {busy ? t('chatIndex.clearing') : t('chatIndex.clearLabel')}
        </Btn>
      </SettingRow>
    </>
  );
}
