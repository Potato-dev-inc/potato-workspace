import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { projectWithCopy } from './shell-labels';
import { hasEverSpawned } from '../../lib/agent-health';
import { sortInbox, type InboxEntry } from '../../lib/inbox-order';
import { isBudget, isCiCard, isConsent, isIssueCard, isLimit, type QuestionAnswer } from '../../lib/questions';
import { patchSettings } from '../../lib/settings';
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
import { RedBanners } from './team/RedBanner';
import { useTeam } from './team/useTeam';
import { teamApi } from '../../lib/team';
import { MissionsSection, readyMissions } from './mission/MissionCards';
import { CollisionSection } from './CollisionSection';
import { useMissions } from '../../lib/missions';
import type { CompanionTransport, CompanionView } from '../../lib/companion';
import { COMPANION_PANE_PREFIX, isCompanionPaneId } from './companion/model';
import { CompanionStoppedCard } from './companion/StoppedCard';

/** One card in the Inbox's single list: where it sorts, and how to draw it. */
interface Entry extends InboxEntry {
  /** A number key can answer it (not high risk, not consent). Drives the keyboard hint. */
  quick: boolean;
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
}: {
  c: CockpitApi;
  /**
   * Counts the times a person chose Inbox in the sidebar. The Inbox is the resting view, so it is often already
   * on screen (its first card focused before the click): the click then leaves the keyboard on the sidebar row.
   * Each new count moves the keyboard back to the first card.
   */
  visit?: number;
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
  // One list for every surface: the badge, the Doto counter and the sidebar group use its length.
  const needs = useNeedsYou(c);
  // The mission cards themselves are drawn by MissionsSection; their count is already in `needs`
  // (CockpitApp passes the missions to useNeedsYouSource), like the tray and the phone's number.
  const missions = useMissions();
  // One Team read for the red-branch banner on top and the Team section below.
  const team = useTeam();
  const count = blockingItems(needs).length;
  const waiting = c.registry.paneList.filter((p) => !isCompanionPaneId(p.info.id) && itemsOfKind(needs, 'approval').some((i) => i.paneId === p.info.id));
  const errored = c.registry.paneList.filter((p) => !isCompanionPaneId(p.info.id) && itemsOfKind(needs, 'error').some((i) => i.paneId === p.info.id));
  const noPanes = c.registry.paneList.length === 0 && c.registry.initialReady;
  const firstRun = noPanes && !hasEverSpawned();
  const setUp = onSetUp === undefined ? onOpenDoctor : onSetUp;
  const stuckIds = itemsOfKind(needs, 'stuck').flatMap((i) => (i.paneId ? [i.paneId] : []));

  // The sign-ins, for a usage-limit card's "Use another sign-in". No store (browser, old backend): the button stays away.
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
      const paneName = (q.consent?.pane_id ?? q.pane_id) ? c.names.get((q.consent?.pane_id ?? q.pane_id)!) : undefined;
      if (isConsent(q)) {
        out.push({
          key: `consent:${q.id}`,
          kind: 'consent',
          since: q.created_at_ms,
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
          quick: false,
          render: () => <IssueCard q={q} now={c.now} onAnswer={answer(q.id)} onOpenPane={open(q.pane_id)} />,
        });
      } else if (isCiCard(q)) {
        // Red to Green: a fix card or a push card for a PR Potato Workspace opened. Like the issue cards, a number key never answers it.
        out.push({
          key: `ci:${q.id}`,
          kind: 'question',
          since: q.created_at_ms,
          quick: false,
          render: () => <CiFixCard q={q} now={c.now} onAnswer={answer(q.id)} onOpenPane={open(q.pane_id)} />,
        });
      } else {
        out.push({
          key: `question:${q.id}`,
          kind: 'question',
          since: q.created_at_ms,
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
      out.push({ key: `stuck:${id}`, kind: 'stuck', quick: true, render: () => <PaneStuckCard c={c} paneId={id} dock={false} /> });
    }
    for (const x of companions ?? []) {
      if (x.state !== 'stopped' || !onRestartCompanion) continue;
      out.push({
        key: `companion:${x.id}`,
        kind: 'companion',
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

  const quick = entries.some((e) => e.quick);
  const title = firstRun ? 'Welcome to Potato Workspace' : count === 0 ? 'Nothing needs you' : count === 1 ? 'One thing needs you' : `${count} things need you`;

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
      <header className="ck-inbox-hero">
        {!firstRun && (
          <div className="ck-doto" aria-label={`${count} ${count === 1 ? 'thing needs' : 'things need'} you`}>
            {String(count).padStart(2, '0')}
          </div>
        )}
        <h1 className="ck-title">{title}</h1>
        <p className="ck-sub">
          {firstRun
            ? 'Your agents work here. First, check which ones this PC has.'
            : count === 0
            ? 'Agents that stop to ask a question will show up here.'
            : 'Answer here, or open the agent.'}
        </p>
        {entries.length > 0 && (
          <p className="ib-hint" aria-label="Keyboard shortcuts">
            <span>
              <kbd className="ib-kbd">J</kbd>
              <kbd className="ib-kbd">K</kbd> move
            </span>
            {quick && (
              <span>
                <kbd className="ib-kbd">1</kbd>
                <kbd className="ib-kbd">2</kbd> answer
              </span>
            )}
            <span>
              <kbd className="ib-kbd">O</kbd> open
            </span>
          </p>
        )}
        <p className="ib-next" role="status" aria-live="polite">
          {nextCard.next !== null && <>Next: {nextCard.next}</>}
        </p>
        {noPanes && !firstRun && onStartAgent && (
          <button type="button" className="ck-btn ck-btn--primary" onClick={onStartAgent}>
            Start an agent
          </button>
        )}
        {noPanes && setUp && (
          <button type="button" className={`ck-btn ${firstRun || !onStartAgent ? 'ck-btn--primary' : 'ck-btn--secondary'}`} onClick={setUp}>
            {firstRun ? 'Set up your agents' : 'Set up agents'}
          </button>
        )}
        {firstRun && onSetUp !== null && (
          <p className="ib-welcome-alt">
            <span>I don't write code.</span>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => void patchSettings({ simple_mode: true }).catch(() => undefined)}>
              Use Simple mode
            </button>
          </p>
        )}
      </header>

      {entries.length > 0 && (
        <ul className="ib-list" aria-label="Needs you">
          {entries.map((e, i) => (
            <li key={e.key} data-ib-key={e.key}>
              {e.render(i === 0)}
            </li>
          ))}
        </ul>
      )}

      <MissionsSection missions={missions.missions} onChanged={missions.reload} onOpenPane={(id) => c.select(id)} onNotify={c.notify} />
      <CollisionSection select={(id) => c.select(id)} hasPane={(id) => c.registry.panes.has(id)} />

      <AskNotices />
      <CanaryNotices />
      <HiddenRuns />
      <ImportChatsCard />

      <TeamSection now={c.now} paneNames={c.names} team={team} />
    </div>
  );
}
