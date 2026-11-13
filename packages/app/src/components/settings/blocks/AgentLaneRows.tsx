// Settings > Agents > How to run: for each agent that has an enabled chat (ACP) definition, a popup that picks how a new
// session runs by default, "Terminal" (the default) or "Chat (ACP)". The terminal stays a full way to run every agent.
// The whole block is hidden while the Labs switch is off. An agent that cannot run as a chat shows why instead.
import { RUN_WAYS } from '../../../lib/glossary';
import { t, useT } from '../../../i18n';
import { useCallback, useEffect, useState } from 'react';
import {
  addableChat,
  errorSentence,
  normalizeLaneView,
  tauriAcpChatApi,
  terminalChatCapable,
  TERMINAL_CHAT_LANE,
  TERMINAL_CHAT_WORD,
  type AcpAddable,
  type AcpChatApi,
  type AcpLaneAgent,
  type AcpLaneView,
  type RunLaneWord,
} from '../../../lib/acpChat';
import { Popup } from '../controls';
import { Btn, SettingRow } from '../settings-ui';
import { AddChatDialog } from './AddChatDialog';
import { RemoveChatDialog } from './RemoveChatDialog';

/** What Remove chat needs of a row: an ACP agent, or an agent that only has Chat (terminal). */
type RemovableAgent = Pick<AcpLaneAgent, 'id' | 'label' | 'addon'> & { overlay?: boolean };

export const TERMINAL_LABEL = 'Terminal';
export const CHAT_LABEL = RUN_WAYS.chat;
export const ADD_CHAT_LABEL = `Add ${RUN_WAYS.chat.toLowerCase()}`;

/** What the popup shows: the saved choice, else what a helper this agent starts would get. */
export function shownLane(agent: AcpLaneAgent): RunLaneWord {
  return agent.saved === false && agent.helper_lane ? agent.helper_lane : agent.lane;
}

/** One plain sentence under the agent's name: how its helpers run. */
export function laneNote(agent: AcpLaneAgent): string {
  if (agent.saved !== false) {
    if (agent.lane === 'acp') return t('lane.noteChat');
    return t('lane.noteTerminal');
  }
  if (agent.helper_lane === 'acp') return t('lane.helperChat');
  if (agent.addon_installed === false) return t('lane.helperNoAddon');
  return t('lane.helperTerminal');
}

export function AgentLaneRows({ api = tauriAcpChatApi, only }: { only?: string; api?: Pick<AcpChatApi, 'laneGet' | 'laneSet'> & Pick<AcpChatApi, 'overlayDetect' | 'overlaySet' | 'overlayRemove' | 'chatRemove'> }) {
  const t = useT();
  const [view, setView] = useState<AcpLaneView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<AcpAddable | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [removing, setRemoving] = useState<RemovableAgent | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .laneGet()
      .then((v) => alive && setView(normalizeLaneView(v)))
      // No desktop shell (a browser preview): there is nothing to choose, so show nothing.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  const save = useCallback(
    async (id: string, lane: RunLaneWord) => {
      setError(null);
      try {
        setView(await api.laneSet(id, lane));
      } catch (e) {
        setError(errorSentence(e));
      }
    },
    [api],
  );

  const refresh = useCallback(async () => {
    try {
      setView(normalizeLaneView(await api.laneGet()));
    } catch {
      // the old list stays
    }
  }, [api]);

  // Remove chat: the sheet asks first. Every agent that has a chat can be removed; the backend stops its open chats,
  // goes back to Terminal, drops an added chat and, if asked, deletes the add-on files.
  const confirmRemove = useCallback(
    async (agent: RemovableAgent, removeAddon: boolean) => {
      setRemoveBusy(true);
      setRemoveError(null);
      try {
        let next: AcpLaneView;
        if (api.chatRemove) next = normalizeLaneView(await api.chatRemove(agent.id, { removeAddon }));
        else if (api.overlayRemove && agent.overlay) {
          await api.overlayRemove(agent.id);
          next = normalizeLaneView(await api.laneGet());
        } else throw new Error(t('lane.cannotRemove'));
        setView(next);
        const failed = (next as AcpLaneView & { removal?: { addon_error?: string | null } }).removal?.addon_error;
        setStatus(failed ? t('lane.removedFailed', { label: agent.label, reason: failed }) : t('lane.removed', { label: agent.label }));
        setRemoving(null);
      } catch (e) {
        setRemoveError(errorSentence(e));
      } finally {
        setRemoveBusy(false);
      }
    },
    [api, t],
  );

  const addable = addableChat(view).filter((a) => !only || a.id === only);
  const terminalChat = terminalChatCapable(view).filter((t) => !only || t.id === only);
  const laneAgents = view ? view.agents.filter((a) => !only || a.id === only) : [];
  if (!view || !view.labs_enabled || (laneAgents.length === 0 && addable.length === 0 && terminalChat.length === 0)) return null;
  const terminalChatNote = (id: string) => {
    const note = terminalChat.find((t) => t.id === id)?.note;
    return note ? <span data-testid="agent-terminal-chat-note"> {note}</span> : null;
  };
  // The rows are direct children of the Settings row wrapper (a wrapping element would make Settings hide the whole block:
  // see the `.st-rowwrap:not(:has(> .st-row))` rule in settings.css). The empty marker is for tests.
  return (
    <>
      <span hidden data-testid="agent-lane" />
      {laneAgents.map((agent) => (
        <SettingRow
          key={agent.id}
          label={only ? t('agentPage.howOpens') : agent.label}
          description={
            <>
              {agent.disabled ? <span data-testid="agent-lane-note">{agent.disabled_note ?? t('lane.notAvailable')}</span> : laneNote(agent)}
              {agent.adapter_note ? <span data-testid="agent-adapter-note"> {agent.adapter_note}</span> : null}
              {terminalChatNote(agent.id)}
            </>
          }
        >
          <Btn
            small
            aria-label={t('lane.removeFor', { label: agent.label })}
            onClick={() => {
              setRemoveError(null);
              setRemoving(agent);
            }}
          >
            {t('lane.removeChat')}
          </Btn>
          {!agent.disabled && (
            <Popup aria-label={t('lane.howRuns', { label: agent.label })} value={shownLane(agent)} onChange={(event) => void save(agent.id, event.target.value as RunLaneWord)}>
              <option value="terminal">{t('agentPage.terminal')}</option>
              <option value="acp">{CHAT_LABEL}</option>
              {terminalChat.some((t) => t.id === agent.id) && <option value={TERMINAL_CHAT_LANE}>{TERMINAL_CHAT_WORD}</option>}
            </Popup>
          )}
        </SettingRow>
      ))}
      {terminalChat
        .filter((tc) => !laneAgents.some((a) => a.id === tc.id))
        .map((tc) => (
          <SettingRow
            key={`tc-${tc.id}`}
            label={only ? t('agentPage.howOpens') : tc.label}
            description={<>{t('lane.newSessions', { word: TERMINAL_CHAT_WORD })}{terminalChatNote(tc.id)}</>}
          >
            {tc.chosen && (
              <Btn
                small
                aria-label={t('lane.removeFor', { label: tc.label })}
                onClick={() => {
                  setRemoveError(null);
                  setRemoving({ id: tc.id, label: tc.label });
                }}
              >
                {t('lane.removeChat')}
              </Btn>
            )}
            <Popup aria-label={t('lane.howRuns', { label: tc.label })} value={tc.chosen ? TERMINAL_CHAT_LANE : 'terminal'} onChange={(event) => void save(tc.id, event.target.value as RunLaneWord)}>
              <option value="terminal">{t('agentPage.terminal')}</option>
              <option value={TERMINAL_CHAT_LANE}>{TERMINAL_CHAT_WORD}</option>
            </Popup>
          </SettingRow>
        ))}
      {addable.map((a) => (
        <SettingRow
          key={`add-${a.id}`}
          label={a.label}
          description={a.reason ? <span data-testid="agent-add-chat-note">{a.reason}</span> : t('lane.noChatYet')}
        >
          <Btn small primary={!a.reason} disabled={!!a.reason} aria-label={t('lane.addFor', { add: t('lane.add'), label: a.label })} onClick={() => setAdding(a)}>
            {t('lane.add')}
          </Btn>
        </SettingRow>
      ))}
      {status && (
        <p role="status" className="text-xs text-pm-muted">
          {status}
        </p>
      )}
      {removing && (
        <RemoveChatDialog
          agent={removing}
          busy={removeBusy}
          error={removeError}
          onCancel={() => setRemoving(null)}
          onRemove={(removeAddon) => void confirmRemove(removing, removeAddon)}
        />
      )}
      {adding && (
        <AddChatDialog
          agent={adding}
          api={api}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setStatus(t('lane.added', { label: adding.label }));
            setAdding(null);
            void refresh();
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-pm-text">
          {error}
        </p>
      )}
    </>
  );
}
