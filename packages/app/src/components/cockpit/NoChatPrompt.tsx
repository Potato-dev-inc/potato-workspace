// The small prompt under an agent's row in the "+" menu when the agent has no working chat yet. It never explains: it
// offers what can be done now, by what the app says is available:
//   "Install chat add-on (17 MB)"  the same install as Settings, with its progress, then the chat starts;
//   "Use adapter"                  opens the add-chat dialog on the adapter, then the chat starts;
//   "Add chat…"                    opens the add-chat dialog for any other way;
//   "Use terminal"                 always: starts the agent in a terminal, once.
// A failed install says why in a few words and keeps every choice. Nothing here names an agent.
import { useEffect, useRef, useState } from 'react';
import { addonFor, plainMessage, type AcpAddonApi, type AddonStatus } from '../../lib/acpAddon';
import { normalizeOptions, type AcpChatApi, type OverlayOption } from '../../lib/acpChat';

/** The agent the prompt is for; `reason` is the app's own words for why a chat cannot be added now. */
export interface NoChatAgent {
  id: string;
  label: string;
  reason?: string;
}

export type AddChatKind = OverlayOption['kind'];

export interface NoChatPromptProps {
  agent: NoChatAgent;
  /** `acp_addon_status` / `acp_addon_install` / progress. Absent: no add-on button. */
  addons?: AcpAddonApi;
  /** `acp_overlay_resolve`. Absent: no adapter or add-chat buttons. */
  resolve?: AcpChatApi['overlayResolve'];
  /** Whether to ask `resolve`: only an agent with no chat at all has ways to be given one. */
  canAdd: boolean;
  /** Start the chat now (after an install). Rejects with the reason. */
  onStartChat: (agentId: string) => Promise<void>;
  /** Open the add-chat dialog; `prefer` picks that way when it is offered. */
  onAddChat: (agent: NoChatAgent, prefer?: AddChatKind) => void;
  /** Start this agent in a terminal, once. */
  onUseTerminal: () => void;
}

/** " (17 MB)" for the button, or nothing when the size is not known. */
const sizeLabel = (mb: number | null | undefined): string => (mb && mb > 0 ? ` (${mb} MB)` : '');

/** A few words: the first sentence of the reason, cut at 120 characters. */
export function shortReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = plainMessage(raw).trim() || 'It did not finish.';
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

type Phase = 'loading' | 'ready' | 'installing' | 'starting';

/** An install is over when it is installed or failed. */
const ended = (s: AddonStatus): boolean => s.state === 'installed' || s.state === 'failed';

/** Give up on an install that has not ended after this long. */
const INSTALL_LIMIT_MS = 12 * 60 * 1000;

export function NoChatPrompt({ agent, addons, resolve, canAdd, onStartChat, onAddChat, onUseTerminal }: NoChatPromptProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [addon, setAddon] = useState<AddonStatus | null>(null);
  const [options, setOptions] = useState<OverlayOption[]>([]);
  const [line, setLine] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const alive = useRef(true);
  // The newest status event for this agent, and the wait for an install's end (null: gave up or unmounted).
  const latest = useRef<AddonStatus | null>(null);
  const waiter = useRef<((s: AddonStatus | null) => void) | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      waiter.current?.(null);
    };
  }, []);

  useEffect(() => {
    let live = true;
    const loadAddon = addons
      ? addons
          .list()
          .then((l) => addonFor(Object.fromEntries(l.addons.map((a) => [a.agent, a])), agent.id) ?? null)
          .catch(() => null)
      : Promise.resolve(null);
    const loadWays = canAdd && resolve ? resolve(agent.id).then((r) => normalizeOptions(r)).catch(() => [] as OverlayOption[]) : Promise.resolve([] as OverlayOption[]);
    void Promise.all([loadAddon, loadWays]).then(([status, ways]) => {
      if (!live) return;
      setAddon(status);
      setOptions(ways);
      setPhase('ready');
    });
    return () => {
      live = false;
    };
  }, [addons, resolve, canAdd, agent.id]);

  const needsAddon = !!addon && addon.state !== 'installed';
  const adapter = options.some((o) => o.kind === 'adapter' && o.available);
  const others = options.some((o) => o.kind !== 'adapter' && o.available);
  const busy = phase === 'installing' || phase === 'starting';

  const install = async () => {
    if (!addons || busy) return;
    setFailure(null);
    setLine('');
    setPhase('installing');
    latest.current = null;
    let stop: (() => void) | undefined;
    try {
      stop = await addons.watch((s) => {
        if (!alive.current || s.agent.toLowerCase() !== agent.id.toLowerCase()) return;
        latest.current = s;
        if (s.lines.length > 0) setLine(s.lines[s.lines.length - 1]);
        if (ended(s)) waiter.current?.(s);
      });
    } catch {
      stop = undefined; // progress is a nicety
    }
    try {
      let done = await addons.install(agent.id);
      if (done.state === 'installing') {
        // The real install runs in the background; its end comes as an event, or shows in the list.
        const end = await new Promise<AddonStatus | null>((resolve) => {
          let poll: ReturnType<typeof setInterval> | undefined;
          let limit: ReturnType<typeof setTimeout> | undefined;
          const finish = (s: AddonStatus | null) => {
            clearInterval(poll);
            clearTimeout(limit);
            waiter.current = null;
            resolve(s);
          };
          if (latest.current && ended(latest.current)) return finish(latest.current);
          waiter.current = finish;
          poll = setInterval(() => {
            addons
              .list()
              .then((l) => {
                const s = addonFor(Object.fromEntries(l.addons.map((a) => [a.agent, a])), agent.id);
                if (s && ended(s)) finish(s);
              })
              .catch(() => {});
          }, 2000);
          limit = setTimeout(() => finish(null), INSTALL_LIMIT_MS);
        });
        if (!alive.current) return;
        if (!end) throw new Error('The install did not finish in 12 minutes.');
        done = end;
      }
      if (done.state !== 'installed') throw new Error(done.detail || 'The install did not finish.');
      if (!alive.current) return;
      setPhase('starting');
      await onStartChat(agent.id);
    } catch (error) {
      if (alive.current) {
        setFailure(shortReason(error));
        setPhase('ready');
      }
    } finally {
      stop?.();
    }
  };

  return (
    <div className="ck-nochat" data-testid={`nochat-${agent.id}`} role="group" aria-label={`Chat for ${agent.label}`}>
      <div className="ck-nochat-title">No chat for {agent.label} yet</div>
      <div className="ck-nochat-actions">
        {needsAddon && addons && (
          <button type="button" className="ck-btn ck-btn--primary ck-btn--sm" disabled={busy} onClick={() => void install()}>
            Install chat add-on{sizeLabel(addon?.size_mb)}
          </button>
        )}
        {adapter && (
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={busy} onClick={() => onAddChat(agent, 'adapter')}>
            Use adapter
          </button>
        )}
        {others && (
          <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={busy} onClick={() => onAddChat(agent)}>
            Add chat…
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={phase === 'starting'} onClick={onUseTerminal}>
          Use terminal
        </button>
      </div>
      {phase === 'loading' && <div className="ck-nochat-note">Checking…</div>}
      {phase === 'installing' && (
        <div className="ck-nochat-note" role="status">
          {line ? `Installing… ${line}` : 'Installing…'}
        </div>
      )}
      {phase === 'starting' && (
        <div className="ck-nochat-note" role="status">
          Starting chat…
        </div>
      )}
      {failure && (
        <div className="ck-nochat-note ck-nochat-note--err" role="alert">
          {failure}
        </div>
      )}
      {phase === 'ready' && !failure && agent.reason && !needsAddon && !adapter && !others && <div className="ck-nochat-note">{agent.reason}</div>}
    </div>
  );
}
