import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { CockpitApi } from '../../hooks/useCockpit';
import { projectWithCopy } from './shell-labels';
import { hasEverSpawned } from '../../lib/agent-health';
import { inboxCardCount, sortInbox, type InboxEntry } from '../../lib/inbox-order';
import { isBudget, isCiCard, isConsent, isIssueCard, isLimit, type QuestionAnswer } from '../../lib/questions';
import { patchSettings } from '../../lib/settings';
import { EmptyState } from '../common/EmptyState';
import { PaneApprovalCard } from './PaneApprovalCard';
import { PaneStuckCard } from './StuckCard';
import { blockingItems, itemsOfKind } from '../../lib/attention';
import { useNeedsYou } from '../../hooks/useNeedsYou';
import { AskNotices } from './AskNotices';
import { CanaryNotices } from './CanaryNotices';
import { HiddenRuns } from './HiddenRuns';
import { ImportChatsCard } from './ImportChatsCard';
import { BudgetCard } from './BudgetCard';
import { ConsentCard } from './ConsentCard';
import { LimitCard } from './LimitCard';
import { QuestionCard } from './QuestionCard';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { IssueCard } from './IssueCard';
import { CiFixCard } from './CiFixCard';
import { PaneErrorCard } from './InboxError';
import { focusWithRing } from './InboxCard';
import { handleInboxKey, isEditable } from './inbox-keys';
import { useNextCard } from './useNextCard';
import { accountsFor, pickableAccounts, signInLabel, tauriAccountsApi, type Account } from '../../lib/accounts';
import { SIGN_IN } from '../../lib/glossary';
import { TeamSection } from './team/TeamSection';
import { DoneToday } from './inbox/DoneToday';
import { WorkingNow } from './inbox/WorkingNow';
import { workingRows } from '../../lib/working-now';
import { IconTick } from './inbox/ActivityIcons';
import { rowOpenProps } from './inbox/row-open';
import { LastTurnContext } from './away-context';
import '../../styles/inbox.css';
import { RedBanners } from './team/RedBanner';
import { useTeam } from './team/useTeam';
import { teamApi } from '../../lib/team';
import { MissionsSection, readyMissions } from './mission/MissionCards';
import { CollisionSection } from './CollisionSection';
import { useMissions } from '../../lib/missions';
import type { CompanionTransport, CompanionView } from '../../lib/companion';
import { COMPANION_PANE_PREFIX, isCompanionPaneId } from './companion/model';
import { CompanionStoppedCard } from './companion/StoppedCard';
import { CrewCanvas } from '../crews/CrewCanvas';
import { crewOf } from '../../lib/crew-members';
import { groupInbox, readInboxView, rootOf, saveInboxView, type InboxView } from '../../lib/inbox-view';
import { remoteProjectParts } from '../../lib/projectLocation';
import { sshApi, type SshHost } from '../../lib/ssh';

/** One card in the Inbox's single list: where it sorts, and how to draw it. */
interface Entry extends InboxEntry {
  /** A number key can answer it (not high risk, not consent). Drives the keyboard hint. */
  quick: boolean;
  /** The chat this card belongs to: clicking the card (or Enter on it) opens it. */
  paneId?: string;
  render: (first: boolean) => ReactNode;
}

export function Inbox({
  c,
  onOpenDoctor,
  onSetUp,
  onStartAgent,
  companions,
  onRestartCompanion,
  companionTransport,
  visit = 0,
  onOpenMorning,
}: {
  c: CockpitApi;
  /**
   * Counts the times a person chose Inbox in the sidebar. The Inbox is the resting view, so it is often already
   * on screen (its first card focused before the click): the click then leaves the keyboard on the sidebar row.
   * Each new count moves the keyboard back to the first card.
   */
  visit?: number;
  /** The Morning report page: a night-shift row in Done today opens it. */
  onOpenMorning?: () => void;
  /** The companions, so a stopped one gets its card (absent: none). */
  companions?: CompanionView[] | null;
  /** The card's "Try again": the desktop calls `companion_restart`. */
  onRestartCompanion?: (id: string) => Promise<unknown> | void;
  /** Moves a companion to another agent: the usage-limit card of a companion's pane offers it. */
  companionTransport?: Pick<CompanionTransport, 'agents' | 'update'>;
  onOpenDoctor?: () => void;
  /**
   * "Set up your agents" on the empty Inbox. The cockpit sends the first-run welcome here while it was
   * never finished or skipped, and Set up agents after. `null`: the welcome is on screen (or paused as its
   * bar), so the Inbox offers no second way in. Absent: Set up agents.
   */
  onSetUp?: (() => void) | null;
  /** "Start an agent" on the empty Inbox: the cockpit opens the New agent page. Absent: Set up agents is the main button. */
  onStartAgent?: () => void;
}) {
  const t = useT();
  // One list for every surface: the badge, the Doto counter and the sidebar group use its length.
  const needs = useNeedsYou(c);
  // The mission cards themselves are drawn by MissionsSection; their count is already in `needs`
  // (CockpitApp passes the missions to useNeedsYouSource), like the tray and the phone's number.
  const missions = useMissions();
  // One Team read for the red-branch banner on top and the Team section below.
  const team = useTeam();
  // The latest finished turn of every chat: Done today lists the ones that ended since midnight.
  const lastTurns = useContext(LastTurnContext);
  // The pane cards use the same de-duplicated list the badge counts (a pane has one problem card, not two).
  const blocking = blockingItems(needs);
  const waiting = c.registry.paneList.filter((p) => !isCompanionPaneId(p.info.id) && itemsOfKind(blocking, 'approval').some((i) => i.paneId === p.info.id));
  const errored = c.registry.paneList.filter((p) => !isCompanionPaneId(p.info.id) && itemsOfKind(blocking, 'error').some((i) => i.paneId === p.info.id));
  const noPanes = c.registry.paneList.length === 0 && c.registry.initialReady;
  const firstRun = noPanes && !hasEverSpawned();
  const setUp = onSetUp === undefined ? onOpenDoctor : onSetUp;
  const stuckIds = itemsOfKind(blocking, 'stuck').flatMap((i) => (i.paneId ? [i.paneId] : []));

  // The sign-ins, for a usage-limit card's "Use another sign-in". No store (browser, old backend): the button stays away.
  // The SSH machines' names, for the "On <host>" line of a card whose chat runs on another computer. A failed read leaves the plain line.
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  useEffect(() => {
    let alive = true;
    sshApi
      .hosts()
      .then((list) => alive && setSshHosts(list))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  // Where a card's chat runs: a chat on another computer has its SSH folder as its pane folder (`remoteProjectParts`).
  const whereLabel = (paneId?: string): string | null => {
    const cwd = paneId && !isCompanionPaneId(paneId) ? c.registry.panes.get(paneId)?.info.cwd : undefined;
    const parts = cwd ? remoteProjectParts(cwd) : null;
    if (!parts) return null;
    const name = sshHosts.find((h) => h.id === parts.hostId)?.name;
    return name ? t('inbox.onHost', { name }) : t('inbox.onAnotherComputer');
  };
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => {
    let alive = true;
    tauriAccountsApi
      .list()
      .then((o) => alive && setAccounts(pickableAccounts(o)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const signInsOf = (paneId?: string) => {
    const info = paneId && !isCompanionPaneId(paneId) ? c.registry.panes.get(paneId)?.info : undefined;
    if (!info) return [];
    const others = accountsFor(accounts, info.agent_type).filter((a) => a.id !== info.account);
    const out = others.map((a) => ({ agentId: info.agent_type, accountId: a.id, label: signInLabel(a), cwd: info.cwd }));
    return info.account ? [{ agentId: info.agent_type, label: SIGN_IN.defaultOne, cwd: info.cwd }, ...out] : out;
  };

  const entries = (() => {
    const out: Entry[] = [];
    const answer = (id: string) => (a: QuestionAnswer) => void c.asked.answerQuestion(id, a);
    const open = (paneId?: string) => (paneId && c.registry.panes.has(paneId) ? () => c.select(paneId) : undefined);
    const age = (since?: number) => (since === undefined ? null : c.now - since);

    for (const q of c.asked.questions) {
      const qPane = q.consent?.pane_id ?? q.pane_id;
      const paneName = (q.consent?.pane_id ?? q.pane_id) ? c.names.get((q.consent?.pane_id ?? q.pane_id)!) : undefined;
      if (isConsent(q)) {
        out.push({
          key: `consent:${q.id}`,
          kind: 'consent',
          since: q.created_at_ms,
          paneId: qPane,
          quick: false,
          render: (first) => (
            <ConsentCard q={q} paneName={paneName} now={c.now} autoFocus={first} onAnswer={answer(q.id)} onOpenPane={open(q.consent?.pane_id)} />
          ),
        });
      } else if (isBudget(q)) {
        out.push({
          key: `budget:${q.id}`,
          kind: 'budget',
          since: q.created_at_ms,
          paneId: qPane,
          quick: true,
          render: () => (
            <BudgetCard q={q} paneName={paneName} now={c.now} onAnswer={answer(q.id)} onDismiss={() => void c.asked.dismissQuestion(q.id)} onOpenPane={open(q.pane_id)} />
          ),
        });
      } else if (isLimit(q)) {
        out.push({
          key: `limit:${q.id}`,
          kind: 'limit',
          since: q.created_at_ms,
          paneId: qPane,
          quick: true,
          render: () => (
            <LimitCard
              q={q}
              paneName={paneName}
              now={c.now}
              onAnswer={answer(q.id)}
              onOpenPane={open(q.pane_id)}
              signIns={signInsOf(q.pane_id)}
              onUseSignIn={(o) => void c.newAgent(o.agentId, o.accountId, false, o.cwd || undefined)}
              companion={q.pane_id && isCompanionPaneId(q.pane_id) ? companions?.find((x) => x.id === q.pane_id!.slice(COMPANION_PANE_PREFIX.length)) : undefined}
              companionTransport={companionTransport}
            />
          ),
        });
      } else if (isIssueCard(q)) {
        // Assign an issue: a start or push card for a GitHub issue. It sorts with the questions.
        out.push({
          key: `issue:${q.id}`,
          kind: 'question',
          since: q.created_at_ms,
          paneId: qPane,
          quick: false,
          render: () => <IssueCard q={q} now={c.now} onAnswer={answer(q.id)} onOpenPane={open(q.pane_id)} />,
        });
      } else if (isCiCard(q)) {
        // Red to Green: a fix card or a push card for a PR Potato Workspace opened. Like the issue cards, a number key never answers it.
        out.push({
          key: `ci:${q.id}`,
          kind: 'question',
          since: q.created_at_ms,
          paneId: qPane,
          quick: false,
          render: () => <CiFixCard q={q} now={c.now} onAnswer={answer(q.id)} onOpenPane={open(q.pane_id)} />,
        });
      } else {
        out.push({
          key: `question:${q.id}`,
          kind: 'question',
          since: q.created_at_ms,
          paneId: qPane,
          quick: q.choices.length > 0,
          render: () => (
            <QuestionCard q={q} paneName={paneName} now={c.now} onAnswer={answer(q.id)} onDismiss={() => void c.asked.dismissQuestion(q.id)} onOpenPane={open(q.pane_id)} onAddLogin={() => openSettingsAt('agents', 'accounts')} />
          ),
        });
      }
    }

    for (const p of waiting) {
      const id = p.info.id;
      const since = c.statusSince.get(id);
      const prompt = c.prompts[id];
      const risk = prompt?.risk?.level;
      const hasChoices = !!prompt && prompt.choices.length > 0;
      out.push({
        key: `approval:${id}`,
        kind: 'approval',
        risk,
        since,
        paneId: id,
        quick: hasChoices && risk !== 'high',
        render: (first) => <PaneApprovalCard c={c} paneId={id} autoFocus={first} onOpen={() => c.select(id)} />,
      });
    }

    for (const p of errored) {
      const id = p.info.id;
      const since = c.statusSince.get(id);
      out.push({
        key: `error:${id}`,
        kind: 'error',
        since,
        paneId: id,
        quick: true,
        render: () => (
          <PaneErrorCard
            c={c}
            paneId={id}
            agentType={p.info.agent_type}
            name={c.names.get(id) ?? p.info.agent_type}
            project={projectWithCopy(p.info.cwd)}
            age={age(since)}
            onOpenDoctor={onOpenDoctor}
          />
        ),
      });
    }

    for (const id of stuckIds) {
      out.push({ key: `stuck:${id}`, kind: 'stuck', paneId: id, quick: true, render: () => <PaneStuckCard c={c} paneId={id} dock={false} /> });
    }
    for (const x of companions ?? []) {
      if (x.state !== 'stopped' || !onRestartCompanion) continue;
      out.push({
        key: `companion:${x.id}`,
        kind: 'companion',
        paneId: x.paneId ?? undefined,
        quick: true,
        render: () => <CompanionStoppedCard companion={x} onTryAgain={onRestartCompanion} onOpenPane={open(x.paneId ?? undefined)} />,
      });
    }
    return sortInbox(out);
  })();

  // The keyboard works without the mouse: when the Inbox first has a card, focus the first one
  // (a high-risk card has already put focus on its Deny). J / K move, 1 2 3 answer, O opens, Esc dismisses.
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || entries.length === 0) return;
    focused.current = true;
    const box = root.current;
    const active = document.activeElement;
    if (!box || (active && box.contains(active))) return;
    if (active && active !== document.body && isEditable(active)) return;
    if (document.querySelector('.ck-sheet, [aria-modal="true"], .ck-away')) return;
    focusWithRing(box.querySelector<HTMLElement>('[data-ib-card]'));
  }, [entries.length]);
  const lastVisit = useRef(visit);
  useEffect(() => {
    if (lastVisit.current === visit) return;
    lastVisit.current = visit;
    if (entries.length === 0 || document.querySelector('.ck-sheet, [aria-modal="true"], .ck-away')) return;
    focusWithRing(root.current?.querySelector<HTMLElement>('[data-ib-card]'));
  }, [visit, entries.length]);

  // The card that was answered leaves; the keyboard goes to the one that took its place, and the line says whose it is.
  const nameOfKey = (key: string): string | undefined => {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (['approval', 'error', 'stuck'].includes(kind)) return c.names.get(id);
    const q = c.asked.questions.find((x) => x.id === id);
    const paneId = q?.consent?.pane_id ?? q?.pane_id;
    return (paneId ? c.names.get(paneId) : undefined) ?? q?.agent;
  };
  const nextCard = useNextCard(root, entries.map((e) => e.key), nameOfKey);

  // The heading counts the cards the person can see: the list above (a stopped companion's card is a helper, not a
  // waiting item, so the sidebar badge leaves it out) and the mission cards drawn by MissionsSection.
  const count = inboxCardCount(entries.map((e) => e.kind), blocking);
  const quick = entries.some((e) => e.quick);
  const [keys, setKeys] = useState(false);

  // "By urgency" (default) or "By crew"; the last choice is remembered.
  const [view, setViewState] = useState<InboxView>(readInboxView);
  const setView = (v: InboxView) => {
    setViewState(v);
    saveInboxView(v);
  };
  // "Show in crew": the canvas of the crew this chat was started in, with its box selected.
  const [crewOpen, setCrewOpen] = useState<{ slug: string; role: string } | null>(null);
  const showInCrew = (paneId?: string) => {
    const m = paneId ? crewOf(paneId) : null;
    return m ? () => setCrewOpen(m) : undefined;
  };
  const working = workingRows(c.registry.paneList, { activities: c.activities, statusSince: c.statusSince, skip: (id) => isCompanionPaneId(id) || stuckIds.includes(id) });
  const parentOf = (id: string) => c.registry.panes.get(id)?.info.parent_pane_id;
  const rootFor = (id: string) => rootOf(id, parentOf);
  const grouped = view === 'crew' ? groupInbox(entries, rootFor) : null;
  const rootName = (root: string | null) => (root === null ? t('inbox.groupOther') : (c.names.get(root) ?? c.registry.panes.get(root)?.info.agent_type ?? root));
  const firstKey = grouped ? [...grouped.pinned, ...grouped.groups.flatMap((g) => g.entries)][0]?.key : entries[0]?.key;
  const renderItem = (e: Entry) => {
    const show = showInCrew(e.paneId);
    const where = whereLabel(e.paneId);
    return (
      <li key={e.key} data-ib-key={e.key} {...rowOpenProps(e.paneId && c.registry.panes.has(e.paneId) ? () => c.select(e.paneId!) : undefined)}>
        {where && (
          <p className="ib-where" data-testid="inbox-where">
            {where}
          </p>
        )}
        {e.render(e.key === firstKey)}
        {show && (
          <button type="button" className="ck-btn ck-btn--plain ck-btn--sm ib-crew-btn" aria-label={t('inbox.showInCrewNamed', { name: nameOfKey(e.key) ?? '' })} onClick={show}>
            {t('inbox.showInCrew')}
          </button>
        )}
      </li>
    );
  };

  return (
    <div
      ref={root}
      className="ck-inbox"
      tabIndex={-1}
      onFocus={nextCard.onFocus}
      onKeyDown={(e) => {
        if (root.current) handleInboxKey(e.nativeEvent, root.current);
      }}
    >
      <RedBanners state={team.state} api={teamApi} now={c.now} onDone={team.refresh} />
      {firstRun ? (
        <EmptyState
          page
          title={t('inbox.welcomeTitle')}
          line={t('inbox.welcomeLine')}
          action={noPanes && setUp ? { label: t('inbox.setUpYourAgents'), onClick: setUp } : null}
          alternatives={
            onSetUp !== null ? [{ label: t('inbox.simpleMode'), onClick: () => void patchSettings({ simple_mode: true }).catch(() => undefined) }] : []
          }
        />
      ) : (
        <header className="ck-inbox-hero ck-inbox-bar">
          <h1 className="ck-title">
            {t('inbox.title')}
            {count > 0 && (
              <span className="ck-inbox-count" aria-label={t('inbox.thingsNeedYou', { count })}>
                {count}
              </span>
            )}
          </h1>
          {(entries.length > 0 || working.length > 0) && (
            <div className="ib-view" role="group" aria-label={t('inbox.viewLabel')}>
              {(['urgency', 'crew'] as const).map((v) => (
                <button key={v} type="button" className={`ck-btn ck-btn--sm ${view === v ? 'ck-btn--secondary' : 'ck-btn--plain'}`} aria-pressed={view === v} onClick={() => setView(v)}>
                  {t(v === 'urgency' ? 'inbox.viewUrgency' : 'inbox.viewCrew')}
                </button>
              ))}
            </div>
          )}
          {entries.length > 0 && (
            <button type="button" className="ck-btn ck-btn--plain ck-btn--sm ib-keys-btn" aria-expanded={keys} onClick={() => setKeys((k) => !k)}>
              {t('inbox.keys')}
            </button>
          )}
        </header>
      )}
      {!firstRun && keys && entries.length > 0 && (
        <p className="ib-hint" aria-label={t('inbox.keyboardShortcuts')}>
          <span>
            <kbd className="ck-chip-key ib-kbd">J</kbd>
            <kbd className="ck-chip-key ib-kbd">K</kbd> {t('inbox.move')}
          </span>
          {quick && (
            <span>
              <kbd className="ck-chip-key ib-kbd">1</kbd>
              <kbd className="ck-chip-key ib-kbd">2</kbd> {t('inbox.answer')}
            </span>
          )}
          <span>
            <kbd className="ck-chip-key ib-kbd">O</kbd> {t('inbox.open')}
          </span>
        </p>
      )}
      <p className="ib-next" role="status" aria-live="polite">
        {nextCard.next !== null && t('inbox.next', { name: nextCard.next })}
      </p>
      {!firstRun && count === 0 && (
        <EmptyState
          plain
          role="status"
          testId="inbox-clear"
          className="ib-clear"
          icon={
            <span className="ib-clear-ok" aria-hidden="true">
              <IconTick size={12} />
            </span>
          }
          title={t('inbox.nothingNeedsYou')}
          line={t('inbox.nothingNeedsYouLine')}
          action={noPanes && onStartAgent ? { label: t('inbox.startAgent'), onClick: onStartAgent, small: true } : noPanes && setUp ? { label: t('inbox.setUpAgents'), onClick: setUp, small: true } : null}
          alternatives={noPanes && onStartAgent && setUp ? [{ label: t('inbox.setUpAgents'), onClick: setUp }] : []}
        />
      )}

      {entries.length > 0 && !grouped && (
        <ul className="ib-list" aria-label={t('inbox.needsYouList')}>
          {entries.map(renderItem)}
        </ul>
      )}
      {entries.length > 0 && grouped && (
        <>
          {grouped.pinned.length > 0 && (
            <ul className="ib-list" aria-label={t('inbox.needsYouList')} data-testid="inbox-pinned">
              {grouped.pinned.map(renderItem)}
            </ul>
          )}
          {grouped.groups.map((g) => {
            const need = g.entries.filter((e) => e.kind !== 'companion').length;
            const busy = g.root === null ? 0 : working.filter((w) => rootFor(w.paneId) === g.root).length;
            return (
              <section key={g.root ?? 'other'} className="ib-group" data-testid="inbox-group" data-group={g.root ?? 'other'}>
                <h2 className="ib-lab">
                  <span>{rootName(g.root)}</span>
                  <span className="ib-lab-n">
                    · {t('inbox.groupNeeds', { count: need })}
                    {busy > 0 ? ` · ${t('inbox.groupWorking', { count: busy })}` : ''}
                  </span>
                </h2>
                <ul className="ib-list" aria-label={rootName(g.root)}>
                  {g.entries.map(renderItem)}
                </ul>
              </section>
            );
          })}
        </>
      )}

      <MissionsSection missions={missions.missions} onChanged={missions.reload} onOpenPane={(id) => c.select(id)} onNotify={c.notify} />
      <CollisionSection select={(id) => c.select(id)} hasPane={(id) => c.registry.panes.has(id)} />

      <AskNotices />
      <CanaryNotices />
      <HiddenRuns />
      <ImportChatsCard />

      {!firstRun && (
        <WorkingNow
          rows={working}
          names={c.names}
          now={c.now}
          onOpen={(id) => c.select(id)}
          onStop={(id) => void c.interrupt(id)}
          onShowInCrew={showInCrew}
        />
      )}

      {!firstRun && <DoneToday summaries={lastTurns} names={c.names} now={c.now} onOpen={(id) => c.select(id)} onMorning={onOpenMorning} hasPane={(id) => c.registry.panes.has(id)} onClosed={() => c.notify(t('inbox.doneClosed'))} />}

      {!firstRun && <TeamSection now={c.now} paneNames={c.names} team={team} />}
      {crewOpen && <CrewCanvas slug={crewOpen.slug} focusRole={crewOpen.role} onClose={() => setCrewOpen(null)} />}
    </div>
  );
}
