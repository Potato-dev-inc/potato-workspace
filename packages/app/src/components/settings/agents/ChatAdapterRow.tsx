// One agent's "Chat adapter" row (Settings > Agents > <agent>): which adapter starts this agent as a chat, or None. Shown on
// EVERY agent page, built-in or added by the wizard, whatever the app has proof of so far: an agent whose chat was never
// set up is the one that needs this row most. Pick / change go through the same "Add chat" dialog (it reads the official
// registry and the reviewed list for the program); Remove asks first. Nothing here names an agent: the lane view says.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { errorSentence, normalizeLaneView, tauriAcpChatApi, type AcpChatApi, type AcpLaneAgent, type AcpLaneView } from '../../../lib/acpChat';
import { Btn, Note, SettingRow } from '../settings-ui';
import { AddChatDialog } from '../blocks/AddChatDialog';
import { RemoveChatDialog } from '../blocks/RemoveChatDialog';

export type ChatAdapterApi = Pick<AcpChatApi, 'laneGet' | 'overlayDetect' | 'overlaySet' | 'overlayRemove' | 'chatRemove'> &
  Partial<Pick<AcpChatApi, 'overlayResolve' | 'overlayInstall' | 'overlayProgress' | 'adapterKeyStatus' | 'adapterKeySet'>>;

export function ChatAdapterRow({ agent, api = tauriAcpChatApi }: { agent: { id: string; label: string }; api?: ChatAdapterApi }) {
  const t = useT();
  const [view, setView] = useState<AcpLaneView | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .laneGet()
      .then((v) => alive && setView(normalizeLaneView(v)))
      .catch(() => undefined); // no desktop shell (a browser preview): nothing to pick
    return () => {
      alive = false;
    };
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      setView(normalizeLaneView(await api.laneGet()));
    } catch {
      // the old view stays
    }
  }, [api]);

  if (!view) return null;
  // The Labs switch does not hide this row: chat is the default way to use an agent.
  const current: AcpLaneAgent | undefined = view.agents.find((a) => a.id === agent.id);
  const reason = (view.can_add_chat ?? []).find((a) => a.id === agent.id)?.reason;

  const remove = async (removeAddon: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (api.chatRemove) setView(normalizeLaneView(await api.chatRemove(agent.id, { removeAddon })));
      else {
        await api.overlayRemove?.(agent.id);
        await refresh();
      }
      setRemoving(false);
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  const description = current ? (current.overlay ? t('chatAdapter.added') : t('chatAdapter.builtin')) : reason ? `${t('chatAdapter.none')} ${t('chatAdapter.notFound')}` : t('chatAdapter.none');
  return (
    <>
      <SettingRow label={t('chatAdapter.label')} description={description}>
        <span data-testid={`chat-adapter-${agent.id}`} data-current={current ? current.label : ''} className="text-sm text-pm-text">
          {current ? current.label : t('chatAdapter.noneShort')}
        </span>
        <Btn
          small
          primary={!current}
          aria-label={current ? t('chatAdapter.changeAria', { label: agent.label }) : t('lane.addFor', { add: t('lane.add'), label: agent.label })}
          onClick={() => setAdding(true)}
        >
          {current ? t('chatAdapter.change') : t('lane.add')}
        </Btn>
        {current && (
          <Btn
            small
            aria-label={t('lane.removeFor', { label: agent.label })}
            onClick={() => {
              setError(null);
              setRemoving(true);
            }}
          >
            {t('lane.removeChat')}
          </Btn>
        )}
      </SettingRow>
      {status && <Note role="status">{status}</Note>}
      {error && !removing && <Note role="alert">{error}</Note>}
      {removing && <RemoveChatDialog agent={current ?? agent} busy={busy} error={error} onCancel={() => setRemoving(false)} onRemove={(a) => void remove(a)} />}
      {adding && (
        <AddChatDialog
          agent={agent}
          api={api}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setStatus(t('chatAdapter.added.status', { label: agent.label }));
            setAdding(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}
