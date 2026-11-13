// Step 1: which agents are on this computer. Claude, Codex, Cursor and OpenCode are looked for by
// themselves; each row is a tick, or one button (Install, Sign in). Nothing to type. Install and sign-in
// help is the Set up agents list, folded away under "Help with an agent" together with the note about
// keeping agents ready. ("How do you work?" is asked on the last screen.)
import { useCallback, useEffect, useRef, useState } from 'react';
import { agentHealthApi, type AgentHealth, type AgentHealthApi } from '../../lib/agent-health';
import type { AgentInstallApi } from '../../lib/agent-install';
import { AgentDoctor } from '../cockpit/AgentDoctor';
import { DotSpinner } from '../cockpit/DotSpinner';
import { useT } from '../../i18n';
import { T } from './copy';
import { usableAgents, WATCHED_AGENTS, type ReadyAgent } from './model';

type Row = Pick<AgentHealth, 'id' | 'label' | 'state' | 'installed'>;

/** The four watched agents, in a fixed order, from a full health list. */
export function watchedRows(rows: AgentHealth[]): AgentHealth[] {
  return WATCHED_AGENTS.flatMap((id) => rows.filter((r) => r.id === id).slice(0, 1));
}

function RowStatus({ row }: { row: Row }) {
  useT();
  if (row.state === 'not_installed' || !row.installed) return <>{T.agentMissing}</>;
  if (row.state === 'needs_login') return <>{T.agentLogin}</>;
  return <>{T.agentFound}</>;
}

export function StepAgents({
  ready,
  warming,
  api = agentHealthApi,
  installApi,
  onReady,
  onNotify,
  onSignIn,
  onShowPane,
}: {
  ready: ReadyAgent[];
  /** Warm agents were started for the demo. */
  warming: boolean;
  api?: AgentHealthApi;
  installApi?: AgentInstallApi;
  onReady: (ready: ReadyAgent[]) => void;
  onNotify: (text: string) => void;
  /** Opens the agent in a window so the person can sign in; the welcome waits as a bar. */
  onSignIn: (agentId: string) => void;
  onShowPane: (paneId: string) => void;
}) {
  useT();
  const [rows, setRows] = useState<AgentHealth[] | null>(null);
  const [help, setHelp] = useState(false);
  const alive = useRef(true);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const apply = useCallback((all: AgentHealth[]) => {
    setRows(watchedRows(all));
    // Only the rows shown count, so "N agents are ready" matches the list.
    onReadyRef.current(usableAgents(watchedRows(all)));
  }, []);

  const check = useCallback(() => {
    api
      .check()
      .then((all) => alive.current && apply(all))
      .catch(() => alive.current && apply([]));
  }, [api, apply]);

  useEffect(() => {
    alive.current = true;
    check();
    return () => {
      alive.current = false;
    };
  }, [check]);

  // Back from a sign-in or install window: look again.
  useEffect(() => {
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [check]);

  return (
    <section className="fr-step" aria-labelledby="fr-agents-t">
      <div className="ck-doto fr-num" aria-hidden="true">01</div>
      <h1 className="ck-title" id="fr-agents-t">{T.agentsTitle}</h1>
      <p className="fr-lead">{T.agentsLead}</p>

      <ul className="fr-agentlist" data-testid="agent-rows">
        {rows === null && <li className="fr-agentrow fr-agentrow--plain fr-hint">{T.agentChecking}</li>}
        {rows?.map((r) => {
          const missing = r.state === 'not_installed' || !r.installed;
          const login = !missing && r.state === 'needs_login';
          return (
            <li key={r.id} className="fr-agentrow" data-state={missing ? 'missing' : login ? 'login' : 'ready'}>
              <DotSpinner status={missing ? 'idle' : login ? 'waiting_input' : 'exited'} size={3} />
              <span className="fr-agentname">{r.label}</span>
              <span className="fr-agentstate">
                <RowStatus row={r} />
              </span>
              {missing && (
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => setHelp(true)}>
                  {T.agentInstall}
                </button>
              )}
              {login && (
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={() => onSignIn(r.id)}>
                  {T.agentSignIn}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <p className="fr-status" role="status" data-ready={ready.length > 0 ? 'true' : 'false'}>
        {rows === null ? T.agentChecking : ready.length > 0 ? T.agentsReady(ready.length) : T.agentsNone}
      </p>

      <div className="fr-actions">
        <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
          {T.agentsMore}
        </button>
      </div>
      {help && warming && <p className="fr-hint" data-testid="warming-note">{T.agentsWarm}</p>}
      {help && (
        <AgentDoctor
          embedded
          api={api}
          installApi={installApi}
          onRows={apply}
          onNotify={onNotify}
          onOpenAgent={onSignIn}
          onShowPane={onShowPane}
        />
      )}
    </section>
  );
}
