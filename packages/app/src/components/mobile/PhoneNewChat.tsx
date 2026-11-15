// "New chat" on the phone: an empty chat with three pills (the agent, the project, and Chat or Terminal when the agent can do
// both) over the same message box as every chat. Send starts it on the PC with the first message. The agents and projects are
// the PC's own (`GET /phone/new-chat`): only a project the PC already knows can be picked, and the path never reaches the phone.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { BridgeClient, PhoneNewChatOptions } from '../../lib/bridge-types';
import { errorSentence } from '../../lib/sayError';
import type { ChatAttachment } from '../../lib/attachFiles';
import { clearDraft } from '../../lib/composerDraft';
import { uploadFile } from '../../lib/phone-upload';
import { shareToDraft, type SharedContent } from '../../pwa/share-target';
import { PhoneAgentTile } from './PhoneAgentTile';
import { Sheet } from './MobileSheet';
import { PhoneComposer } from './PhoneComposer';
import { PhoneNewChatModel, usePhoneModelList } from './PhoneNewChatModel';
import '../../styles/phone-newchat.css';

type Lane = 'chat' | 'terminal';
type Picking = 'project' | null;

/** The box's own draft while a share is open: kept apart from the plain new chat's, and forgotten when the screen closes. */
const SHARE_DRAFT_KEY = 'share-chat';
const STAGED = 'staged:';

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
  shared = null,
}: {
  bridge: BridgeClient;
  /** This phone may start things (`control`). Without it the box says so. */
  canControl: boolean;
  grid?: SpawnGrid | null;
  onClose: () => void;
  /** The chat is running on the PC. `sent` is false when the first message did not go (the chat opens anyway). */
  onStarted: (paneId: string, lane: Lane, sent: boolean) => void;
  /** Something the person shared from another app: it fills the box (words) and the chips (pictures, files). Nothing goes until Send. */
  shared?: SharedContent | null;
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
  // Pictures and files from a share are held here until the chat exists: `upload` has to name a pane, and there is none yet.
  const staged = useRef(new Map<string, File>());
  const fill = useMemo(() => (shared ? { text: shareToDraft(shared), nonce: 1 } : null), [shared]);
  const stage = useCallback(async (file: File): Promise<ChatAttachment> => {
    const key = `${STAGED}${staged.current.size + 1}-${Date.now()}`;
    staged.current.set(key, file);
    return { name: file.name, path: key, kind: file.type.startsWith('image/') ? 'image' : 'file', size: file.size, mime: file.type };
  }, []);
  const closeScreen = useCallback(() => {
    if (shared) clearDraft(SHARE_DRAFT_KEY);
    onClose();
  }, [shared, onClose]);
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
      if (event.key === 'Escape' && !picking) closeScreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeScreen, picking]);

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
    async (text: string, attachments: ChatAttachment[] = []): Promise<string | null> => {
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
      // Shared pictures and files go to the new chat first; if one cannot go, the message waits (the chat is open, send it again).
      const files: ChatAttachment[] = [];
      try {
        for (const item of attachments) {
          const held = item.path.startsWith(STAGED) ? staged.current.get(item.path) : undefined;
          files.push(held ? await uploadFile(bridge, started.pane_id, held, t('phone.attach.failed')) : item);
        }
      } catch {
        sent = false;
      }
      try {
        if (!sent) throw new Error('files did not go');
        if (!bridge.sendPaneMessage) throw new Error('no route');
        await (files.length > 0 ? bridge.sendPaneMessage(started.pane_id, text, files) : bridge.sendPaneMessage(started.pane_id, text));
      } catch {
        sent = false;
      }
      if (shared) clearDraft(SHARE_DRAFT_KEY);
      staged.current.clear();
      setStarting(null);
      onStarted(started.pane_id, lane, sent);
      return null;
    },
    [agent, project, bridge, lane, grid, onStarted, t, chosenModel, modelList, shared],
  );

  const blocked = useMemo(() => {
    if (!canControl) return t('phone.nc.needControl');
    if (options && options.agents.length === 0) return t('phone.nc.noAgents');
    if (options && options.projects.length === 0) return t('phone.nc.noProjects');
    if (!options) return loadError ?? t('phone.nc.loading');
    return null;
  }, [canControl, options, loadError, t]);

  return (
    <div className="ph-nc" role="dialog" aria-modal="true" aria-label={shared ? t('phone.share.title') : t('phone.nc.title')} data-testid="phone-new-chat">
      <div className="ph-nc-top">
        <button type="button" className="ph-nc-x" aria-label={t('phone.nc.close')} onClick={closeScreen}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <h1>{shared ? t('phone.share.title') : t('phone.nc.title')}</h1>
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
            <p className="ph-nc-hint">{shared ? t('phone.share.hint') : t('phone.nc.hint')}</p>
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
      <PhoneComposer onSend={send} blockedReason={blocked} draftKey={shared ? SHARE_DRAFT_KEY : 'new-chat'} model={null} fill={fill} upload={shared && shared.files.length > 0 ? stage : null} initialFiles={shared?.files} pill={lane === 'chat' && agent ? <PhoneNewChatModel list={modelList} picked={chosenModel} onPick={(value) => setModelPick(value && agentId ? { agent: agentId, value } : null)} /> : null} />
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
