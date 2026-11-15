// "New chat" on the phone: an empty chat with three pills (the agent, the project, and Chat or Terminal when the agent can do
// both) over the same message box as every chat. Send starts it on the PC with the first message. The agents and projects are
// the PC's own (`GET /phone/new-chat`): only a project the PC already knows can be picked, and the path never reaches the phone.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import type { BridgeClient, PhoneNewChatOptions } from '../../lib/bridge-types';
import { errorSentence } from '../../lib/sayError';
import { PhoneAgentTile } from './PhoneAgentTile';
import { Sheet } from './MobileSheet';
import { PhoneComposer } from './PhoneComposer';
import { PhoneNewChatModel, usePhoneModelList } from './PhoneNewChatModel';
import '../../styles/phone-newchat.css';

type Lane = 'chat' | 'terminal';
type Picking = 'project' | null;

/** The phone's grid for a terminal pane, when it is known: the pane starts at it and the phone holds it. */
export interface SpawnGrid {
  cols: number;
  rows: number;
  viewer: string;
}

export function PhoneNewChat({
  bridge,
  canControl,
  grid,
  onClose,
  onStarted,
}: {
  bridge: BridgeClient;
  /** This phone may start things (`control`). Without it the box says so. */
  canControl: boolean;
  grid?: SpawnGrid | null;
  onClose: () => void;
  /** The chat is running on the PC. `sent` is false when the first message did not go (the chat opens anyway). */
  onStarted: (paneId: string, lane: Lane, sent: boolean) => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<PhoneNewChatOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [laneChoice, setLaneChoice] = useState<Lane | null>(null);
  const [picking, setPicking] = useState<Picking>(null);
  // While Send is on its way: which step the PC is on, and for how long (the chat program can take several seconds to wake).
  const [starting, setStarting] = useState<{ step: 'wake' | 'send'; since: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** The model picked for the new chat, per agent (null: the agent's own default). */
  const [modelPick, setModelPick] = useState<{ agent: string; value: string } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setOptions(null);
    if (!bridge.phoneNewChat) {
      setLoadError(t('phone.nc.loadFailed'));
      return;
    }
    bridge
      .phoneNewChat()
      .then((body) => {
        setOptions(body);
        setAgentId((cur) => cur ?? body.agents.find((a) => a.chat)?.id ?? body.agents[0]?.id ?? null);
        setProjectId((cur) => cur ?? body.projects[0]?.id ?? null);
      })
      .catch(() => setLoadError(t('phone.nc.loadFailed')));
  }, [bridge, t]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !picking) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, picking]);

  const agent = options?.agents.find((a) => a.id === agentId) ?? null;
  const project = options?.projects.find((p) => p.id === projectId) ?? null;
  // The PC hides terminals (its "Show terminals" setting is off): there is no Chat | Terminal choice, only a chat.
  const terminalsOk = options?.terminals !== false;
  const both = terminalsOk && !!agent && agent.chat && agent.terminal;
  const lane: Lane = both ? (laneChoice ?? 'chat') : agent?.chat || !terminalsOk ? 'chat' : 'terminal';

  // The PC starts the agent's chat program as soon as an agent and a project are picked, so Send finds it ready.
  const warmKey = canControl && lane === 'chat' && agent && project ? `${agent.id}|${project.id}` : null;
  useEffect(() => {
    if (!warmKey || !agent || !project || !bridge.phoneWarm) return;
    bridge.phoneWarm({ agent: agent.id, project: project.id }).catch(() => undefined);
    // Only a change of agent or project asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmKey, bridge]);

  useEffect(() => {
    if (!starting) {
      setElapsed(0);
      return;
    }
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - starting.since) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [starting]);
  const modelList = usePhoneModelList(bridge, agentId);
  const chosenModel = modelPick && modelPick.agent === agentId ? modelPick.value : null;

  const send = useCallback(
    async (text: string): Promise<string | null> => {
      if (!agent || !project || !bridge.phoneStartChat) return t('phone.nc.loadFailed');
      let started: { pane_id: string };
      setStarting({ step: 'wake', since: Date.now() });
      try {
        started = await bridge.phoneStartChat({ agent: agent.id, project: project.id, lane, ...(lane === 'terminal' && grid ? grid : {}) });
      } catch (error) {
        setStarting(null);
        return / -> 403/.test(errorSentence(error)) ? t('phone.nc.needControl') : errorSentence(error);
      }
      let sent = true;
      setStarting((cur) => (cur ? { ...cur, step: 'send' } : cur));
      // The model is set on the new chat before its first message goes (the chat's own settings route).
      if (chosenModel && lane === 'chat' && modelList.status === 'ready' && bridge.acpSetConfig) {
        try {
          await bridge.acpSetConfig(started.pane_id, modelList.optionId, chosenModel);
        } catch {
          /* the chat starts on its own default; the settings pill in the chat still works */
        }
      }
      try {
        if (!bridge.sendPaneMessage) throw new Error('no route');
        await bridge.sendPaneMessage(started.pane_id, text);
      } catch {
        sent = false;
      }
      setStarting(null);
      onStarted(started.pane_id, lane, sent);
      return null;
    },
    [agent, project, bridge, lane, grid, onStarted, t, chosenModel, modelList],
  );

  const blocked = useMemo(() => {
    if (!canControl) return t('phone.nc.needControl');
    if (options && options.agents.length === 0) return t('phone.nc.noAgents');
    if (options && options.projects.length === 0) return t('phone.nc.noProjects');
    if (!options) return loadError ?? t('phone.nc.loading');
    return null;
  }, [canControl, options, loadError, t]);

  return (
    <div className="ph-nc" role="dialog" aria-modal="true" aria-label={t('phone.nc.title')} data-testid="phone-new-chat">
      <div className="ph-nc-top">
        <button type="button" className="ph-nc-x" aria-label={t('phone.nc.close')} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <h1>{t('phone.nc.title')}</h1>
      </div>
      <div className="ph-nc-body">
        {!options && !loadError && <p className="ph-nc-hint" role="status">{t('phone.nc.loading')}</p>}
        {loadError && (
          <div className="ph-nc-hint" role="alert">
            <p>{loadError}</p>
            <button type="button" className="ph-btn" onClick={load}>
              {t('phone.nc.tryAgain')}
            </button>
          </div>
        )}
        {options && starting && agent && (
          <div className="ph-nc-pick" role="status" aria-live="polite" data-testid="nc-starting">
            <p className="ph-nc-hint">
              <strong>{t('phone.nc.waking', { name: agent.label })}</strong>
            </p>
            <ul className="ph-nc-starting">
              <li data-done={starting.step === 'send' || undefined}>
                {starting.step === 'send' ? '✓ ' : ''}
                {t('phone.nc.stepWake', { name: agent.label })}
                {starting.step === 'wake' && elapsed > 0 ? ` · ${t('phone.nc.stepSeconds', { count: elapsed })}` : ''}
              </li>
              <li data-done={starting.step === 'wake' || undefined}>{t('phone.nc.stepSend')}</li>
            </ul>
            {starting.step === 'wake' && elapsed >= 6 && <p className="ph-nc-hint ph-nc-hint--small">{t('phone.nc.slow')}</p>}
          </div>
        )}
        {options && !starting && (
          <div className="ph-nc-pick">
            <p className="ph-nc-hint">{t('phone.nc.hint')}</p>
            <div className="ph-nc-tiles" role="radiogroup" aria-label={t('phone.nc.agent')} data-testid="nc-tiles">
              {options.agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  className="ph-nc-tile"
                  aria-checked={a.id === agentId}
                  aria-disabled={!a.chat && !terminalsOk ? true : undefined}
                  data-needs-terminal={!a.chat && !terminalsOk ? '' : undefined}
                  data-testid="nc-agent-tile"
                  onClick={() => {
                    if (!a.chat && !terminalsOk) return;
                    setAgentId(a.id);
                    setLaneChoice(null);
                  }}
                >
                  <PhoneAgentTile id={a.id} name={a.label} />
                  <span className="ph-nc-tile-txt">
                    <span className="ph-nc-tile-name">{a.label}</span>
                    {!a.chat && !terminalsOk && <span className="ph-nc-tile-tag">{t('phone.nc.needsTerminalTag')}</span>}
                  </span>
                </button>
              ))}
            </div>
            {(options.need_terminals ?? 0) > 0 && !picking && (
              <p className="ph-nc-hint ph-nc-hint--small" data-testid="nc-need-terminals">{t('phone.nc.needTerminals', { count: options.need_terminals ?? 0 })}</p>
            )}
          </div>
        )}
      </div>
      {options && (
        <div className="ph-nc-pills" role="group" aria-label={t('phone.nc.title')}>
          <button type="button" className="ph-nc-pill" data-testid="nc-project-pill" aria-haspopup="dialog" disabled={options.projects.length === 0} onClick={() => setPicking('project')}>
            <span>{project ? t('phone.nc.pillProject', { name: project.name }) : t('phone.nc.pickProject')}</span>
          </button>
          {both && (
            <div className="ph-nc-lane" role="radiogroup" aria-label={t('phone.nc.lane')} data-testid="nc-lane">
              {(['chat', 'terminal'] as const).map((choice) => (
                <button key={choice} type="button" role="radio" aria-checked={lane === choice} data-on={lane === choice || undefined} onClick={() => setLaneChoice(choice)}>
                  {choice === 'chat' ? t('phone.nc.laneChat') : t('phone.nc.laneTerminal')}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <PhoneComposer onSend={send} blockedReason={blocked} draftKey="new-chat" model={null} pill={lane === 'chat' && agent ? <PhoneNewChatModel list={modelList} picked={chosenModel} onPick={(value) => setModelPick(value && agentId ? { agent: agentId, value } : null)} /> : null} />
      {picking === 'project' && options && (
        <Sheet title={t('phone.nc.pickProject')} onClose={() => setPicking(null)}>
          <ul className="ph-group ph-nc-list" aria-label={t('phone.nc.project')}>
            {options.projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="ph-row"
                  aria-current={p.id === projectId ? 'true' : undefined}
                  onClick={() => {
                    setProjectId(p.id);
                    setPicking(null);
                  }}
                >
                  <span className="ph-txt">
                    <span className="ph-t">{p.name}</span>
                  </span>
                  {p.id === projectId && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </div>
  );
}
