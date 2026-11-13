// "New chat" on the phone: an empty chat with three pills (the agent, the project, and Chat or Terminal when the agent can do
// both) over the same message box as every chat. Send starts it on the PC with the first message. The agents and projects are
// the PC's own (`GET /phone/new-chat`): only a project the PC already knows can be picked, and the path never reaches the phone.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import type { BridgeClient, PhoneNewChatOptions } from '../../lib/bridge-types';
import { errorSentence } from '../../lib/sayError';
import { AgentLogo } from '../common/AgentLogo';
import { Sheet } from './MobileSheet';
import { PhoneComposer } from './PhoneComposer';
import '../../styles/phone-newchat.css';

type Lane = 'chat' | 'terminal';
type Picking = 'agent' | 'project' | null;

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

  const send = useCallback(
    async (text: string): Promise<string | null> => {
      if (!agent || !project || !bridge.phoneStartChat) return t('phone.nc.loadFailed');
      let started: { pane_id: string };
      try {
        started = await bridge.phoneStartChat({ agent: agent.id, project: project.id, lane, ...(lane === 'terminal' && grid ? grid : {}) });
      } catch (error) {
        return / -> 403/.test(errorSentence(error)) ? t('phone.nc.needControl') : errorSentence(error);
      }
      let sent = true;
      try {
        if (!bridge.sendPaneMessage) throw new Error('no route');
        await bridge.sendPaneMessage(started.pane_id, text);
      } catch {
        sent = false;
      }
      onStarted(started.pane_id, lane, sent);
      return null;
    },
    [agent, project, bridge, lane, grid, onStarted, t],
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
        {options && <p className="ph-nc-hint">{t('phone.nc.hint')}</p>}
      </div>
      {options && (
        <div className="ph-nc-pills" role="group" aria-label={t('phone.nc.title')}>
          <button type="button" className="ph-nc-pill" data-testid="nc-agent-pill" aria-haspopup="dialog" disabled={options.agents.length === 0} onClick={() => setPicking('agent')}>
            {agent && <AgentLogo id={agent.id} name={agent.label} size={16} decorative />}
            <span>{agent ? t('phone.nc.pillAgent', { name: agent.label }) : t('phone.nc.pickAgent')}</span>
          </button>
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
      <PhoneComposer onSend={send} blockedReason={blocked} draftKey="new-chat" model={null} pill={null} />
      {picking === 'agent' && options && (
        <Sheet title={t('phone.nc.pickAgent')} onClose={() => setPicking(null)}>
          <ul className="ph-group ph-nc-list" aria-label={t('phone.nc.agent')}>
            {options.agents.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="ph-row"
                  aria-current={a.id === agentId ? 'true' : undefined}
                  onClick={() => {
                    setAgentId(a.id);
                    setLaneChoice(null);
                    setPicking(null);
                  }}
                >
                  <AgentLogo id={a.id} name={a.label} size={22} decorative />
                  <span className="ph-txt">
                    <span className="ph-t">{a.label}</span>
                    <span className="ph-s">{[a.chat && t('phone.nc.laneChat'), a.terminal && terminalsOk && t('phone.nc.laneTerminal')].filter(Boolean).join(' · ')}</span>
                  </span>
                  {a.id === agentId && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
          {(options.need_terminals ?? 0) > 0 && (
            <p className="ph-nc-hint" data-testid="nc-need-terminals">
              {t('phone.nc.needTerminals', { count: options.need_terminals ?? 0 })}
            </p>
          )}
        </Sheet>
      )}
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
