// The crew canvas (Labs "Crews"): a crew as boxes. Open a crew of yours or a ready-made one, change a role, add or take out
// a helper, try a task, save, and keep the crew's helpers ready. Opened from Settings > Helpers > Crews (CrewsPage).
// A ready-made crew is read-only until "Save my own copy". Nothing here starts a task or opens a pane.
//
// 1.1.8 slots, deliberately left open (do not build them here):
//   - Follow a task: built (Follow.tsx lights the path of a real task box by box; TryTask is the dry-run twin).
//   - (Built) Change the crew by talking: the Talk tab (TalkToCrew.tsx). Routing only; the person presses Apply; Undo after.
//   - Crew on the phone: a crew card on the phone (view and control only; editing stays here).
//   - Templates and sharing: built (CrewGallery and ImportSheet on CrewsPage; "Share" below writes the crew as one file).
import { useEffect, useMemo, useRef, useState } from 'react';
import { isSettingsEntry } from '../../lib/settings-entry';
import { liveWord, eventText, frontPaneOf, liveHelpers, roleStates, useLiveFeed, useLivePanes, useNow, workflowStatus, type LivePane } from '../../lib/workflow-live';
import { requestOpenHelper } from '../../lib/openHelper';
import { useT } from '../../i18n';
import { Menu } from '../common/Floating';
import { DEFAULT_AGENT, crewErrorText, crewsApi, type Crew, type CrewAgents, type CrewOpened, type CrewProblem, type CrewsApi } from '../../lib/crews-api';
import { shipApi, type ShipApi } from '../../lib/ship-api';
import type { CrewTalkApi } from '../../lib/crew-talk-api';
import { ApplySheet } from './ApplySheet';
import { CanvasSurface } from './CanvasSurface';
import { RoleEditor } from './RoleEditor';
import { TryTask } from './TryTask';
import { Follow, NO_TRACE, type Trace } from './Follow';
import { TalkToCrew, type Shown } from './TalkToCrew';
import { useModelNamer } from './modelNames';
import { WorkflowPanel } from './WorkflowPanel';
import { LiveStrip } from './LiveStrip';
import { MAX_ROLES, addRole, afterAddInWorkflow, isCalled, isWorkflow, keyOf, moveRole, removeRole, type Spot } from './model';
import '../../styles/crew-canvas.css';

const CHECK_DELAY_MS = 350;
const json = (c: Crew, rules: string) => JSON.stringify([c, rules]);

type Tab = 'role' | 'try' | 'follow' | 'talk' | 'live';

export function CrewCanvas({
  slug,
  api = crewsApi,
  ship = shipApi,
  defaultFolder,
  onClose,
  onSaved,
  focusRole,
  talkApi,
  workflows = false,
  startTab,
  onOpenHelper,
  liveSource,
}: {
  slug: string;
  api?: CrewsApi;
  ship?: Pick<ShipApi, 'pickFolder'>;
  defaultFolder?: string | null;
  onClose: () => void;
  /** A crew was saved (a new copy or a change): the page reads its list again. */
  onSaved?: (slug: string) => void;
  /** Open with this role's box selected (the Inbox's "Show in crew"). */
  focusRole?: string;
  /** The front desk's command (tests give a fake). */
  talkApi?: CrewTalkApi;
  /** Labs "Workflows" is on: the lead may be marked the Front of a workflow. */
  workflows?: boolean;
  /** Open on the Live tab (the chat's "Open live view"). It shows only when a chat was started as this crew's front. */
  startTab?: 'live';
  /** A helper box was clicked in the Live tab. Absent: the app opens it (spin-off chat, or the read-only view of a minion). */
  onOpenHelper?: (frontPaneId: string, helperId: string) => void;
  /** The chat that opens this view gives its own pane id (the front), the cockpit's pane list and the chats with a question waiting. */
  liveSource?: { frontId: string; panes: ReadonlyArray<LivePane>; asking: ReadonlySet<string> };
}) {
  const t = useT();
  const [opened, setOpened] = useState<CrewOpened | null>(null);
  const [failed, setFailed] = useState(false);
  const [agents, setAgents] = useState<CrewAgents | null>(null);
  const [crew, setCrew] = useState<Crew | null>(null);
  const [rules, setRules] = useState('');
  const [baseline, setBaseline] = useState('');
  const [problems, setProblems] = useState<CrewProblem[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [tabPicked, setTab] = useState<Tab>(startTab ?? 'role');
  const [path, setPath] = useState<string[]>([]);
  const [trace, setTrace] = useState<Trace>(NO_TRACE);
  const [talkShown, setTalkShown] = useState<Shown | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sharing, setSharing] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    setOpened(null);
    setFailed(false);
    Promise.all([api.open(slug), api.agents().catch(() => null)])
      .then(([found, choices]) => {
        if (!live) return;
        setOpened(found);
        setAgents(choices);
        setCrew(found.crew);
        setRules(found.routing_text);
        setBaseline(json(found.crew, found.routing_text));
        setProblems(found.problems);
        const at = focusRole ? found.crew.roles.findIndex((r) => isCalled(r, focusRole)) : -1;
        setSelected(at >= 0 ? at : null);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [api, slug, focusRole]);

  const readOnly = opened?.kind === 'template';
  const dirty = !!crew && json(crew, rules) !== baseline;

  // The crew is checked again a moment after the person stops changing it (the model and the hand-offs included).
  useEffect(() => {
    if (!crew || readOnly || !dirty) return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .check(crew)
        .then((found) => live && setProblems(found))
        .catch(() => undefined);
    }, CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, crew, readOnly, dirty]);

  const agentName = useMemo(() => {
    const list = agents?.agents ?? [];
    return (id: string) => (id === DEFAULT_AGENT ? t('crewcanvas.agent.default') : (list.find((a) => a.id === id)?.label ?? id));
  }, [agents, t]);

  const modelName = useModelNamer(crew?.roles.map((r) => r.agent_type) ?? []);

  // The live view (Labs "Workflows"): the chat that was started as this crew's front, and the helpers it started.
  const wfOn = workflows && !!crew && isWorkflow(crew);
  // The separate Settings window cannot open a chat in the cockpit window: no Live tab there. Inside the cockpit the chat that
  // opened this view hands over its own pane list, its questions and its own id, so the counts match the crew chip.
  const standalone = !liveSource && isSettingsEntry(window.location.search);
  const own = useLivePanes(wfOn && !liveSource && !standalone);
  const panes: ReadonlyArray<LivePane> = liveSource?.panes ?? own.panes;
  const asking = liveSource?.asking ?? own.asking;
  const frontPane: LivePane | null = useMemo(
    () => (!crew || !wfOn || standalone ? null : liveSource ? (panes.find((p) => p.info.id === liveSource.frontId) ?? null) : frontPaneOf(crew, slug, panes)),
    [crew, wfOn, standalone, liveSource, panes, slug],
  );
  const liveOn = !!frontPane;
  const tab: Tab = tabPicked === 'live' && !liveOn ? 'role' : tabPicked;
  const showTalk = tab === 'talk';
  const frontId = frontPane?.info.id ?? null;
  const helpers = useMemo(
    () => (crew && frontId ? liveHelpers(crew, panes, frontId, (p) => p.info.title?.trim() || agentName(p.info.agent_type), asking) : []),
    [crew, panes, frontId, agentName, asking],
  );
  const feed = useLiveFeed(helpers, liveOn);
  const clock = useNow(liveOn && tab === 'live');
  const liveRoles = useMemo(() => roleStates(helpers, feed.endedAt), [helpers, feed.endedAt]);
  const openHelper = (id: string) => (frontId ? (onOpenHelper ?? requestOpenHelper)(frontId, id) : undefined);

  if (failed) {
    return (
      <div className="crewc" role="dialog" aria-label={t('crewcanvas.aria')}>
        <div className="crewc-head">
          <p className="crewc-error" role="alert">
            {t('crewcanvas.loadFailed')}
          </p>
          <button type="button" className="crewc-btn" onClick={onClose}>
            {t('crewcanvas.close')}
          </button>
        </div>
      </div>
    );
  }
  if (!opened || !crew) {
    return (
      <div className="crewc" role="dialog" aria-label={t('crewcanvas.aria')}>
        <p className="crewc-hint crewc-loading">{t('crewcanvas.loading')}</p>
      </div>
    );
  }

  const edit = (next: Crew) => {
    setCrew(next);
    setNote(null);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const out = await api.saveCanvas(crew, rules, !readOnly);
      if (out.slug && out.errors.length === 0) {
        const fresh = await api.open(out.slug);
        setOpened(fresh);
        setCrew(fresh.crew);
        setRules(fresh.routing_text);
        setBaseline(json(fresh.crew, fresh.routing_text));
        setProblems(fresh.problems);
        setNote(t('crewcanvas.saved'));
        onSaved?.(out.slug);
      } else {
        const first = out.errors[0];
        setError(first?.code === 'CREW_NAME_TAKEN' ? t('crewcanvas.nameTaken') : (first?.message ?? t('crewcanvas.saveFailed')));
        setProblems(out.errors);
      }
    } catch (err) {
      setError(crewErrorText(err));
    }
    setSaving(false);
  };

  const share = async () => {
    setSharing(true);
    setError(null);
    setNote(null);
    try {
      const where = await api.exportFile(crew, rules);
      if (where) setNote(t('crewcanvas.share.done', { path: where }));
    } catch (err) {
      setError(crewErrorText(err) || t('crewcanvas.share.failed'));
    }
    setSharing(false);
  };

  const first = agents?.agents[0]?.id ?? null;
  const full = crew.roles.length >= MAX_ROLES;
  const blocked = problems.length > 0;
  const applyWhy = blocked ? t('crewcanvas.applyFixFirst') : !readOnly && dirty ? t('crewcanvas.applySaveFirst') : null;
  const add = (parent: string) => {
    setMenu(false);
    if (!first) return;
    const next = afterAddInWorkflow(crew, addRole(crew, parent, first, t('crewcanvas.role.jobStart')), t('crewcanvas.wf.whenStart'));
    edit(next);
    setSelected(next.roles.length - 1);
    setTab('role');
  };

  return (
    <div className="crewc" role="dialog" aria-modal="true" aria-label={t('crewcanvas.aria')} data-testid="crew-canvas">
      <div className="crewc-head">
        {readOnly ? (
          <label className="crewc-field crewc-name">
            <span>{t('crewcanvas.name')}</span>
            <input type="text" value={crew.name} maxLength={60} onChange={(e) => edit({ ...crew, name: e.target.value })} />
          </label>
        ) : (
          <h2 className="crewc-title">{crew.name}</h2>
        )}
        <div className="crewc-head-actions">
          <button
            type="button"
            ref={addRef}
            className="crewc-btn"
            disabled={readOnly || full || !first || tab === 'live'}
            title={full ? t('crewcanvas.full', { count: MAX_ROLES }) : !first ? t('crewcanvas.noAgent') : undefined}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            {t('crewcanvas.add')}
          </button>
          {menu ? (
            <Menu anchorRef={addRef} align="start" label={t('crewcanvas.add')} onClose={() => setMenu(false)}>
              {crew.roles.map((r) => (
                <button key={keyOf(r)} type="button" role="menuitem" className="ck-menu-item" onClick={() => add(keyOf(r))}>
                  {t('crewcanvas.addUnder', { name: r.name })}
                </button>
              ))}
            </Menu>
          ) : null}
          {readOnly ? (
            <button type="button" className="crewc-btn crewc-btn--primary" disabled={saving || !crew.name.trim() || tab === 'live'} onClick={() => void save()}>
              {saving ? t('crewcanvas.saving') : t('crewcanvas.copy')}
            </button>
          ) : (
            <button type="button" className="crewc-btn crewc-btn--primary" disabled={saving || !dirty || blocked || tab === 'live'} onClick={() => void save()}>
              {saving ? t('crewcanvas.saving') : t('crewcanvas.save')}
            </button>
          )}
          <button type="button" className="crewc-btn" disabled={sharing} title={t('crewcanvas.share.hint')} onClick={() => void share()}>
            {t('crewcanvas.share')}
          </button>
          <button type="button" className="crewc-btn" disabled={!!applyWhy || tab === 'live'} title={applyWhy ?? undefined} onClick={() => setApplying(true)}>
            {t('crewcanvas.apply')}
          </button>
          <button type="button" className="crewc-btn crewc-btn--quiet" onClick={onClose}>
            {t('crewcanvas.close')}
          </button>
        </div>
      </div>

      <div className="crewc-status" aria-live="polite">
        {readOnly ? <span>{t('crewcanvas.readonly')}</span> : dirty ? <span>{t('crewcanvas.unsaved')}</span> : note ? <span>{note}</span> : null}
        {readOnly && note ? <span>{note}</span> : null}
        {problems.length > 0 ? (
          <span className="crewc-bad" data-testid="crew-problems">
            {t('crewcanvas.problems', { count: problems.length })}: {problems[0].message}
          </span>
        ) : null}
        {error ? (
          <span className="crewc-bad" role="alert">
            {error}
          </span>
        ) : null}
      </div>

      <div className="crewc-body">
        <CanvasSurface
          crew={showTalk && talkShown ? talkShown.crew : crew}
          selected={selected}
          onSelect={(i) => {
            setSelected(i);
            if (i !== null && tab !== 'follow') setTab('role');
          }}
          onMove={(i, to: Spot) => edit(moveRole(crew, i, to))}
          problems={problems}
          agentName={agentName}
          modelName={modelName}
          path={trace.path.length > 0 ? trace.path : path}
          now={trace.now}
          hops={trace.hops}
          readOnly={readOnly || showTalk || tab === 'live'}
          live={
            tab === 'live' && frontPane
              ? {
                  roles: liveRoles,
                  frontWorking: frontPane.status === 'running',
                  dots: feed.dots,
                  pulse: feed.pulse,
                  now: clock,
                  onOpen: (roleKey) => {
                    const id = liveRoles.get(roleKey)?.helperId;
                    if (id) openHelper(id);
                  },
                }
              : undefined
          }
          changed={showTalk && talkShown ? talkShown.changed : undefined}
          touched={showTalk && talkShown ? talkShown.touched : undefined}
          onAddRole={readOnly || showTalk || full || !first ? undefined : () => add(keyOf(crew.roles.find((r) => !r.parent) ?? crew.roles[0]))}
        />
        <aside className="crewc-side" aria-label={t('crewcanvas.tabs')}>
          <div className="crewc-tabs" role="tablist">
            {(liveOn ? (['live', 'role', 'try', 'follow', 'talk'] as const) : (['role', 'try', 'follow', 'talk'] as const)).map((id) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
                {t(`crewcanvas.tab.${id}` as never)}
              </button>
            ))}
          </div>
          {tab === 'live' ? (
            <div className="crewc-live-side" data-testid="live-side">
              <p className="crewc-hint">{t('crewcanvas.live.note')}</p>
              <p className="crewc-live-summary" data-testid="live-summary">
                {workflowStatus(helpers, t) ?? ''}
              </p>
              {helpers.some((h) => !h.roleKey) ? (
                <div data-testid="live-other">
                  <h3 className="crewc-live-head">{t('crewcanvas.live.other')}</h3>
                  <ul className="crewc-live-other">
                    {helpers
                      .filter((h) => !h.roleKey)
                      .map((h) => (
                        <li key={h.id}>
                          <button type="button" className="crewc-link" aria-label={t('crewcanvas.live.open', { title: h.title })} onClick={() => openHelper(h.id)}>
                            <span className="crewc-live-state" data-state={h.state}>
                              {liveWord(h.state, t)}
                            </span>{' '}
                            {h.title}
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {tab === 'role' && isWorkflow(crew) ? <WorkflowPanel crew={crew} disabled={readOnly} onChange={edit} /> : null}
          {tab === 'role' ? (
            selected !== null && crew.roles[selected] ? (
              <RoleEditor
                crew={crew}
                index={selected}
                agents={agents}
                disabled={readOnly}
                modelName={modelName}
                workflows={workflows}
                onChange={edit}
                onRemove={() => {
                  edit(removeRole(crew, selected));
                  setSelected(null);
                }}
              />
            ) : (
              <p className="crewc-hint">{t('crewcanvas.pick')}</p>
            )
          ) : null}
          {tab === 'follow' ? <Follow crew={crew} api={api} onTrace={setTrace} /> : null}
          {tab === 'try' ? (
            <TryTask crew={crew} routingText={rules} onRoutingText={(v) => { setRules(v); setNote(null); }} api={api} disabled={readOnly} onPath={setPath} />
          ) : null}
          <div hidden={tab !== 'talk'}>
            <TalkToCrew
              crew={crew}
              rules={rules}
              disabled={readOnly}
              api={talkApi}
              onShow={setTalkShown}
              onApply={(next, nextRules) => {
                setCrew(next);
                setRules(nextRules);
                setNote(null);
              }}
            />
          </div>
        </aside>
      </div>

      {tab === 'live' ? <LiveStrip log={feed.log.map((e) => ({ key: e.key, at: e.at, text: eventText(e, t), kind: e.kind }))} /> : null}

      {applying ? <ApplySheet crew={crew} api={api} ship={ship} defaultFolder={defaultFolder} onClose={() => setApplying(false)} /> : null}
    </div>
  );
}
