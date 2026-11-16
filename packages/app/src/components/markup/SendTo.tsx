// "Send to": who gets the marks. One button shows the agent that is picked now (its brand icon, name and project); it opens the
// shared menu layer with every running agent: brand icon, name, project and a short status. One click on an agent sends. The
// last row is "New agent". Arrow keys move, Enter sends, Escape closes. No ids and no pane numbers are ever drawn.
import { useRef, useState } from 'react';
import { useT, type MessageKey } from '../../i18n';
import type { MarkupAgent } from '../../lib/markup/api';
import { AgentLogo } from '../common/AgentLogo';
import { Menu } from '../common/Floating';

const STATUS_KEY: Record<MarkupAgent['status'], MessageKey> = {
  working: 'markup.status.working',
  waiting: 'markup.status.waiting',
  idle: 'markup.status.idle',
  stopped: 'markup.status.stopped',
};

export function AgentLine({ agent, current }: { agent: MarkupAgent; current?: boolean }) {
  const t = useT();
  return (
    <>
      <AgentLogo id={agent.agentId} name={agent.name} size={20} decorative />
      <span className="mk-to-text">
        <span className="mk-to-name">
          {agent.name}
          {agent.task ? <span className="mk-to-task"> · {agent.task}</span> : null}
        </span>
        <span className="mk-to-sub">
          {agent.project ? `${agent.project} · ` : ''}
          <span className={`mk-to-status is-${agent.status}`}>{t(STATUS_KEY[agent.status])}</span>
          {current ? ` · ${t('markup.thisPage')}` : ''}
        </span>
      </span>
    </>
  );
}

export function SendTo({
  agents,
  to,
  owner,
  busy,
  onOpen,
  onSendTo,
  onNewAgent,
}: {
  agents: MarkupAgent[];
  /** The agent picked now. */
  to: string | null;
  /** The agent that made the page (marked "This page"). */
  owner: string | null;
  busy: boolean;
  onOpen: () => void;
  onSendTo: (id: string) => void;
  onNewAgent: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const picked = agents.find((a) => a.id === to) ?? agents.find((a) => a.ok) ?? null;
  if (agents.length === 0) {
    return (
      <span className="mk-to-empty" data-testid="markup-to-empty">
        <span>{t('markup.noAgents')}</span>
        <button type="button" className="mk-to-start" onClick={onNewAgent} data-testid="markup-start-agent">
          {t('markup.startAgent')}
        </button>
      </span>
    );
  }
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="mk-to-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('markup.toPick')}
        onClick={() => {
          if (!open) onOpen();
          setOpen((v) => !v);
        }}
        data-testid="markup-to"
      >
        <span className="mk-to-lead">{t('markup.to')}</span>
        {picked ? <AgentLogo id={picked.agentId} name={picked.name} size={16} decorative /> : null}
        <span className="mk-to-now">{picked ? picked.name : t('markup.toPick')}</span>
        <span aria-hidden="true">{'▾'}</span>
      </button>
      {open && (
        <Menu anchorRef={anchor} align="end" prefer="up" minWidth={300} maxHeight={360} label={t('markup.toPick')} testId="markup-to-menu" onClose={() => setOpen(false)}>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className={`mk-to-row${a.id === picked?.id ? ' is-picked' : ''}`}
              disabled={!a.ok || busy}
              title={a.ok ? undefined : (a.reason ?? undefined)}
              onClick={() => {
                setOpen(false);
                onSendTo(a.id);
              }}
              data-testid={`markup-to-${a.id}`}
            >
              <AgentLine agent={a} current={a.id === owner} />
              {a.id === picked?.id ? (
                <svg className="mk-to-check" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4.5 10.5l3.5 3.5 7.5-8" />
                </svg>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="mk-to-row mk-to-new"
            onClick={() => {
              setOpen(false);
              onNewAgent();
            }}
            data-testid="markup-to-new"
          >
            <span className="mk-to-plus" aria-hidden="true">
              +
            </span>
            <span className="mk-to-text">
              <span className="mk-to-name">{t('markup.newAgent')}</span>
            </span>
          </button>
        </Menu>
      )}
    </>
  );
}
