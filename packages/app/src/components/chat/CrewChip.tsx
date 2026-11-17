// The crew chip: ONE small chip pinned at the top of a chat that started other agents. It counts them ("3 spin-offs · 2
// minions"); with exactly one it names it and a click goes straight there. Else a click opens a small list: Spin-offs (you
// talk to them, a click opens their chat) and Minions (you only watch, a click opens a read-only view). A finished one
// stays in the list, marked done, until the chat closes. Nothing is drawn when this chat started nothing.
import { useRef, useState } from 'react';
import '../../styles/crew-chip.css';
import { useT } from '../../i18n';
import { crewChipView, crewGroups, stateWord, visibleRows, type CrewKind, type CrewMember } from '../../lib/crew-chip';
import { AgentLogo } from '../common/AgentLogo';
import { Popover } from '../common/Floating';
import { DotSpinner } from '../cockpit/DotSpinner';
import { formatElapsed } from '../cockpit/model';
import { StopSquare } from '../cockpit/rail/BackgroundSection';

/** A small mark for the kind, so a spin-off (a branch) and a minion (a cube) never look alike. */
function KindGlyph({ kind }: { kind: CrewKind }) {
  return (
    <svg className="ck-crew-kind" viewBox="0 0 16 16" aria-hidden="true" data-kind={kind}>
      {kind === 'spin_off' ? (
        <path d="M5 3v6.5a2.5 2.5 0 0 0 2.5 2.5H11M5 3 3 5M5 3l2 2M11 12l-2-2M11 12l-2 2" />
      ) : (
        <path d="M8 2.5 12.8 5.25v5.5L8 13.5l-4.8-2.75v-5.5ZM8 8v5.5M8 8 3.2 5.25M8 8l4.8-2.75" />
      )}
    </svg>
  );
}

function Row({ m, now, onOpen, onStop }: { m: CrewMember; now: number; onOpen: (id: string) => void; onStop?: (id: string) => Promise<void> | void }) {
  const t = useT();
  const live = m.state === 'working' || m.state === 'needs-you';
  return (
    <li className="ck-crew-row" data-testid="crew-row" data-kind={m.kind} data-state={m.state}>
      <button type="button" className="ck-crew-open" title={t(m.kind === 'minion' ? 'crew.peek' : 'crew.open', { title: m.title })} onClick={() => onOpen(m.id)}>
        <KindGlyph kind={m.kind} />
        <AgentLogo id={m.agentType ?? ''} size={13} decorative />
        <span className="ck-crew-title">{m.title}</span>
        <span className="ck-crew-state" data-state={m.state}>
          {stateWord(m.state, t)}
        </span>
        {live && <span className="ck-crew-time">{formatElapsed(now - m.startedAt)}</span>}
      </button>
      {live && onStop && (
        <span className="ck-crew-stop">
          <StopSquare name={m.title} onStop={() => onStop(m.id)} />
        </span>
      )}
    </li>
  );
}

export function CrewChip({ members, now, onOpen, onStop, onOpenLive, defaultOpen = false }: { /** The list starts open (the evidence pages). */ defaultOpen?: boolean; /** This chat is the front of a running workflow: the list ends with "Open live view" (and a lone helper opens in the list, not at once). */ onOpenLive?: () => void; members: ReadonlyArray<CrewMember>; now: number; onOpen: (id: string) => void; onStop?: (id: string) => Promise<void> | void }) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState<ReadonlySet<CrewKind>>(new Set());
  const setGroup = (kind: CrewKind, on: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (on) next.add(kind);
      else next.delete(kind);
      return next;
    });
  const view = crewChipView(members, t);
  if (!view) return null;
  const only = onOpenLive ? null : view.only;
  const dot = view.tone === 'needs-you' ? 'waiting_input' : view.tone === 'working' ? 'running' : null;
  return (
    <div className="ck-crew-bar" data-testid="crew-bar">
      <button
        ref={anchor}
        type="button"
        className="ck-crew-chip"
        data-testid="crew-chip"
        data-tone={view.tone}
        aria-haspopup={only ? undefined : 'dialog'}
        aria-expanded={only ? undefined : open}
        title={view.text}
        onClick={() => (only ? onOpen(only.id) : setOpen((v) => !v))}
      >
        {dot && <DotSpinner status={dot} size={3} />}
        <span className="ck-crew-text">{view.text}</span>
      </button>
      {open && !only && (
        <Popover anchorRef={anchor} align="start" label={t('crew.aria')} testId="crew-panel" className="ck-crew-panel" minWidth={260} maxHeight={420} onClose={() => setOpen(false)}>
          {crewGroups(members).map((g) => {
            const { rows, folded } = visibleRows(g, expanded.has(g.kind));
            return (
              <section key={g.kind} className="ck-crew-group" data-testid="crew-group" data-kind={g.kind}>
                <h3 className="ck-crew-head">{t(g.kind === 'minion' ? 'crew.group.minions' : 'crew.group.spinOffs', { n: g.members.length })}</h3>
                <ul className="ck-crew-list">
                  {rows.map((m) => (
                    <Row
                      key={m.id}
                      m={m}
                      now={now}
                      onOpen={(id) => {
                        setOpen(false);
                        onOpen(id);
                      }}
                      onStop={onStop}
                    />
                  ))}
                </ul>
                {folded > 0 && (
                  <button type="button" className="ck-crew-fold" data-testid="crew-show-done" onClick={() => setGroup(g.kind, true)}>
                    {t('crew.showDone', { n: folded })}
                  </button>
                )}
                {folded === 0 && expanded.has(g.kind) && (
                  <button type="button" className="ck-crew-fold" data-testid="crew-hide-done" onClick={() => setGroup(g.kind, false)}>
                    {t('crew.hideDone')}
                  </button>
                )}
              </section>
            );
          })}
          {onOpenLive && (
            <button
              type="button"
              className="ck-crew-fold ck-crew-live"
              data-testid="crew-open-live"
              onClick={() => {
                setOpen(false);
                onOpenLive();
              }}
            >
              {t('crewcanvas.live.openView')}
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}
