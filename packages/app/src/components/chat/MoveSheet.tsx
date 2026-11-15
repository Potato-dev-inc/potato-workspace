// "Move to…": the sheet the chat menu opens. Pick a device, say what goes along (the conversation, or the conversation and
// the work), pick the agent and the project there, and Move. The move itself is `lib/moveChat.ts`. A reply that is still
// running refuses it up front; any failure closes nothing and says why in one sentence.
import { useEffect, useId, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { deviceNotices, devicesApi, runtimesOf, stateSentence, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { farOptions, runMove, type FarOptions, type MoveApi, type MoveMode } from '../../lib/moveChat';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { errorSentence } from '../../lib/sayError';
import { Sheet } from '../cockpit/Sheet';
import '../../styles/chat-move.css';

export interface MoveSheetProps {
  paneId: string;
  /** The agent this chat runs (its id), and its name for the person. */
  agentType: string;
  agentLabel: string;
  /** A reply is running: the move is refused. */
  running: boolean;
  /** The chat is a chat session (not a terminal): only a chat can take its work along. */
  isChat: boolean;
  view: DevicesView | null;
  api: MoveApi;
  devices?: DevicesApi;
  onClose: () => void;
  onMoved: (node: string, farPane: string) => void;
}

export function MoveSheet({ paneId, agentType, agentLabel, running, isChat, view, api, devices = devicesApi, onClose, onMoved }: MoveSheetProps) {
  const t = useT();
  const titleId = useId();
  const [pickedNode, setPickedNode] = useState<string | null>(null);
  const [options, setOptions] = useState<FarOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<MoveMode>('history');
  const [agent, setAgent] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => runtimesOf(view).flatMap((r) => (r.kind === 'device' ? [r] : [])), [view]);
  const picked: Device | null = rows.find((r) => r.device.node === pickedNode)?.device ?? null;
  const bridge = useMemo(() => (picked ? makeRemoteClient(picked.node, devices) : null), [picked?.node, devices]);

  useEffect(() => {
    setOptions(null);
    setLoadError(null);
    setAgent(null);
    setProject(null);
    if (!bridge) return;
    let live = true;
    farOptions(bridge).then(
      (o) => {
        if (!live) return;
        setOptions(o);
        // The same agent when the far side has it, else its first one.
        setAgent(o.agents.find((a) => a.id === agentType)?.id ?? o.agents[0]?.id ?? null);
        setProject(o.projects[0]?.id ?? null);
      },
      (e: unknown) => live && setLoadError(errorSentence(e)),
    );
    return () => {
      live = false;
    };
  }, [bridge, agentType]);

  const sameAgentThere = !!options?.agents.some((a) => a.id === agentType);
  // The work only goes to the same agent, and only a chat has work to take.
  const workOff = !isChat ? t('move.workNeedsChat') : options && !sameAgentThere ? t('move.workSameAgent', { agent: agentLabel }) : null;
  const effectiveMode: MoveMode = workOff ? 'history' : mode;
  const chosenAgent = effectiveMode === 'work' ? agentType : agent;
  const signedOut = picked && chosenAgent ? deviceNotices(picked, [chosenAgent]).filter((n) => n.kind === 'signedOut') : [];
  const needsControl = picked && picked.level !== 'full' ? t('move.needsControl', { name: picked.name }) : null;
  const farProblem =
    options === null
      ? null
      : options.agents.length === 0
        ? t('move.noAgents', { name: picked?.name ?? '' })
        : chosenAgent && !options.agents.some((a) => a.id === chosenAgent)
          ? t('move.noAgentThere', { name: picked?.name ?? '', agent: agentLabel })
          : options.projects.length === 0
            ? t('move.noProjects', { name: picked?.name ?? '' })
            : null;
  const why = running ? t('move.running') : needsControl ?? farProblem ?? (signedOut.length > 0 ? signedOut[0].text : null);
  const ready = !!picked && !!bridge && !!options && !!chosenAgent && !!project && !why && !busy;

  const go = async () => {
    if (!ready || !picked || !bridge || !chosenAgent || !project) return;
    setBusy(true);
    setError(null);
    try {
      const done = await runMove({ paneId, mode: effectiveMode, device: picked, bridge, devices, api, fromName: view?.name || 'this PC', agent: chosenAgent, project });
      onMoved(picked.node, done.farPane);
    } catch (e) {
      setError(errorSentence(e));
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={busy ? undefined : onClose} role="dialog" labelledBy={titleId} className="ck-branch-sheet ck-move-sheet">
      <div id={titleId} className="ck-title">
        {t('move.title')}
      </div>
      {running && (
        <p className="ck-sub ck-move-note" role="alert" data-testid="move-running">
          {t('move.running')}
        </p>
      )}
      <div className="ck-branch-label">{t('move.pickDevice')}</div>
      {rows.length === 0 && <p className="ck-sub">{t('move.noDevices')}</p>}
      <div className="ck-branch-list" role="radiogroup" aria-label={t('move.pickDevice')}>
        {rows.map((r) => (
          <label key={r.id} className={`ck-branch-row${r.pickable ? '' : ' is-off'}`} data-testid={`move-device-${r.id}`}>
            <input type="radio" name="move-device" checked={pickedNode === r.device.node} disabled={!r.pickable || busy} onChange={() => setPickedNode(r.device.node)} />
            <span className="ck-branch-name">{r.label}</span>
            <span className="ck-branch-state">{stateSentence(r.device)}</span>
          </label>
        ))}
      </div>

      {picked && options === null && loadError === null && <p className="ck-sub">{t('move.asking', { name: picked.name })}</p>}
      {picked && loadError !== null && <p className="ck-sub ck-move-note">{loadError}</p>}

      {picked && options !== null && (
        <>
          <div className="ck-branch-label">{t('move.way')}</div>
          <div className="ck-branch-list" role="radiogroup" aria-label={t('move.way')}>
            <label className="ck-branch-row ck-move-way">
              <input type="radio" name="move-way" checked={effectiveMode === 'history'} disabled={busy} onChange={() => setMode('history')} />
              <span className="ck-branch-name">{t('move.history')}</span>
              <span className="ck-branch-state">{t('move.historyHint')}</span>
            </label>
            <label className={`ck-branch-row ck-move-way${workOff ? ' is-off' : ''}`} title={workOff ?? undefined}>
              <input type="radio" name="move-way" checked={effectiveMode === 'work'} disabled={!!workOff || busy} onChange={() => setMode('work')} />
              <span className="ck-branch-name">{t('move.work')}</span>
              <span className="ck-branch-state">{workOff ?? t('move.workHint')}</span>
            </label>
          </div>

          {effectiveMode === 'history' && options.agents.length > 0 && (
            <label className="ck-move-field">
              <span className="ck-branch-label">{t('move.agentThere')}</span>
              <select value={agent ?? ''} disabled={busy} onChange={(e) => setAgent(e.target.value)} data-testid="move-agent">
                {options.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {options.projects.length > 0 && (
            <label className="ck-move-field">
              <span className="ck-branch-label">{t('move.projectThere')}</span>
              <select value={project ?? ''} disabled={busy} onChange={(e) => setProject(e.target.value)} data-testid="move-project">
                {options.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!running && why && (
            <p className="ck-sub ck-move-note" data-testid="move-why">
              {why}
              {signedOut.length > 0 && signedOut[0].hint ? ` ${signedOut[0].hint}` : ''}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="ck-sub ck-move-note" role="alert" data-testid="move-error">
          {error}
        </p>
      )}
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--sm" disabled={busy} onClick={onClose}>
          {t('move.close')}
        </button>
        <button type="button" className="ck-btn ck-btn--sm ck-btn--primary" disabled={!ready} onClick={() => void go()} data-testid="move-go">
          {busy ? t('move.moving') : t('move.go')}
        </button>
      </div>
    </Sheet>
  );
}
