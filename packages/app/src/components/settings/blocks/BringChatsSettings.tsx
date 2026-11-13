// Settings > General: "Bring my chats". Shows how many old chats are in search, a button that opens the Bring
// panel, and a button that removes them (asks first). Reading this status touches no agent folder.
import { errorSentence } from '../../../lib/sayError';
import { en } from '../../../i18n/en';
import { t, useT } from '../../../i18n';
import { useEffect, useState } from 'react';
import { chatCount, chatImportClear, chatImportState, requestBringChats } from '../../../lib/chatImport';
import type { SettingsEnv } from '../model';
import { Btn, SettingRow } from '../settings-ui';

export const BRING_CHATS_REMOVE_BODY = en['bring.removeBody'];

/** "Not added" for none, otherwise "538 chats" (or "1 chat"). */
export function bringChatsStatusText(chats: number): string {
  if (chats <= 0) return t('bring.notAdded');
  return chatCount(chats);
}

export function BringChatsSettings({ env }: { env: SettingsEnv }) {
  const t = useT();
  // null until the first answer; the count only, never a folder.
  const [chats, setChats] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void chatImportState()
      .then((state) => live && setChats(state.imported.chats))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const remove = async () => {
    env.setError(null);
    const ok = await env.confirm({ title: t('bring.removeTitle'), body: t('bring.removeBody'), confirmLabel: t('settings.remove') });
    if (!ok) return;
    setBusy(true);
    try {
      const status = await chatImportClear();
      setChats(status.importedChats ?? 0);
      env.markSaved();
    } catch (error) {
      env.setError(errorSentence(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow label={t('agentsRows.bringLabel')} description={chats === null ? t('teamPage.loading') : bringChatsStatusText(chats)}>
      <Btn onClick={() => requestBringChats()}>{t('agentsRows.bringBtn')}</Btn>
      <Btn disabled={busy || !chats} onClick={() => void remove()}>
        {busy ? t('bridge.removing') : t('bring.removeBtn')}
      </Btn>
    </SettingRow>
  );
}
