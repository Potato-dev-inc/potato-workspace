// Settings > Danger zone: "Reset settings" (confirm built into the row) and "Uninstall everything" (a three-step
// flow: check the list, confirm, watch it happen). Monochrome. The commands are Rust (uninstall::commands); the
// block takes an `UninstallApi` so tests use a fake. Nothing here removes anything by itself.
import { errorSentence } from '../../../lib/sayError';
import { useCallback, useEffect, useRef, useState } from 'react';
import '../../../styles/uninstall.css';
import {
  defaultSelection,
  realUninstallApi,
  summaryLine,
  type UninstallApi,
  type UninstallGroup,
  type UninstallPlan,
  type UninstallProgress,
  type UninstallSelection,
} from '../../../lib/uninstall';
import type { RowDef, SettingsEnv } from '../model';
import { Btn, Note, SettingRow } from '../settings-ui';
import { t } from '../../../i18n';

export const RESET_HINT = 'Put every setting back. Your agents and chats stay.';
export const UNINSTALL_HINT = 'Remove Potato Workspace and all it added, as if never installed.';
export const NOT_IN_DEV_TEXT = 'Not in the dev build';
export const CONFIRM_WORD = 'UNINSTALL';
const MAX_ITEMS_SHOWN = 8;

const errorText = (error: unknown) => (errorSentence(error));

// ---------- Reset settings ----------

export function ResetRow({ env, api = realUninstallApi }: { env?: Pick<SettingsEnv, 'markSaved' | 'setError'>; api?: UninstallApi }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = async () => {
    setBusy(true);
    setError(null);
    env?.setError(null);
    try {
      await api.resetSettings();
      setAsking(false);
      setDone(true);
      env?.markSaved();
    } catch (e) {
      setError(t('r12ui.dz.notReset', { why: errorText(e) }));
      env?.setError(t('r12ui.dz.notReset', { why: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow label={t('settings.row.reset-settings.label')} description={t('settings.row.reset-settings.hint')}>
        <Btn
          disabled={asking || busy}
          onClick={() => {
            setDone(false);
            setAsking(true);
          }}
        >
          {t('r12ui.dz.resetBtn')}
        </Btn>
      </SettingRow>
      {asking && (
        <div className="st-row" role="group" aria-label={t('r12ui.dz.confirmReset')}>
          <div className="st-label">
            <span>{t('r12ui.dz.sure')}</span>
            <small>{t('r12ui.dz.resetAsk')}</small>
          </div>
          <div className="st-control">
            <Btn onClick={() => setAsking(false)} disabled={busy}>
              {t('r12ui.dz.cancel')}
            </Btn>
            <Btn primary onClick={() => void reset()} disabled={busy}>
              {busy ? t('r12ui.dz.resetting') : t('settings.row.reset-settings.label')}
            </Btn>
          </div>
        </div>
      )}
      {done && <Note role="status">{t('r12ui.dz.resetDone')}</Note>}
      {error && <Note role="alert">{error}</Note>}
    </>
  );
}

// ---------- Uninstall everything ----------

type Step = 'closed' | 'list' | 'confirm' | 'run';

function GroupCard({ group, ticked, onToggle }: { group: UninstallGroup; ticked: boolean; onToggle: (on: boolean) => void }) {
  const shown = group.items.slice(0, MAX_ITEMS_SHOWN);
  const more = group.items.length - shown.length;
  return (
    <div className={`st-un-group${group.keepReason ? ' is-kept' : ''}`}>
      <label className="st-un-grouphead">
        <input type="checkbox" checked={ticked} onChange={(e) => onToggle(e.target.checked)} aria-label={group.title} />
        <span className="st-un-grouptext">
          <span className="st-un-title">{group.title}</span>
          <small>{group.keepReason && !ticked ? `${group.detail} ${group.keepReason}` : group.detail}</small>
        </span>
        {group.size && <span className="st-un-size">{group.size}</span>}
      </label>
      {group.items.length > 0 && (
        <details className="st-un-items">
          <summary>{t('r12ui.dz.showWhat')}</summary>
          <ul>
            {shown.map((item, i) => (
              <li key={`${item.label}-${i}`}>{item.label}</li>
            ))}
            {more > 0 && <li className="st-un-more">{t('r12ui.dz.plusMore', { n: more })}</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

function Flow({ api, allowed, plan, onClose }: { api: UninstallApi; allowed: { allowed: boolean; reason: string | null }; plan: UninstallPlan; onClose: () => void }) {
  const [step, setStep] = useState<Exclude<Step, 'closed'>>('list');
  const [selection, setSelection] = useState<UninstallSelection>(() => defaultSelection(plan));
  const [typed, setTyped] = useState('');
  const [events, setEvents] = useState<UninstallProgress[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const unlisten = useRef<(() => void) | null>(null);

  useEffect(() => () => unlisten.current?.(), []);

  const toggle = (id: string, on: boolean) =>
    setSelection((s) => ({ ...s, groups: on ? (s.groups.includes(id) ? s.groups : [...s.groups, id]) : s.groups.filter((g) => g !== id) }));

  const start = useCallback(async () => {
    setStep('run');
    setFailure(null);
    setEvents([]);
    unlisten.current?.();
    unlisten.current = await api.onProgress((p) => setEvents((list) => [...list.filter((e) => e.step !== p.step), p].sort((a, b) => a.index - b.index)));
    try {
      await api.run(selection);
      setFinished(true);
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [api, selection]);

  const ticked = (id: string) => selection.groups.includes(id);
  const program = plan.groups.some((g) => g.id === 'program' && ticked('program'));
  const chatsGroup = plan.groups.some((g) => g.id === 'chats');
  const chatsNote = selection.keepChats ? t('r12ui.dz.chatsSaved') : chatsGroup && ticked('chats') ? t('r12ui.dz.chatsDeleted') : t('r12ui.dz.chatsStay');
  const canGo = typed.trim().toUpperCase() === CONFIRM_WORD && allowed.allowed;

  const total = events[0]?.total ?? 0;
  const doneCount = events.filter((e) => e.state === 'done' || e.state === 'skipped').length;
  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const everyStepDone = total > 0 && doneCount >= total;

  return (
    <div className="st-un-flow">
      <ol className="st-un-steps" aria-label={t('r12ui.dz.stepsLabel')}>
        {([t('r12ui.dz.step1'), t('r12ui.dz.step2'), t('r12ui.dz.step3')] as const).map((name, i) => {
          const at = step === 'list' ? 1 : step === 'confirm' ? 2 : 3;
          return (
            <li key={name} className={i + 1 <= at ? 'is-on' : ''} aria-current={i + 1 === at ? 'step' : undefined}>
              <b>{i + 1}</b>
              {name}
            </li>
          );
        })}
      </ol>

      {step === 'list' && (
        <section>
          <h3>{t('settings.row.uninstall-everything.label')}</h3>
          <p className="st-un-lead">{t('r12ui.dz.lead')}</p>
          <div className="st-un-group st-un-keepchats">
            <label className="st-un-grouphead">
              <input type="checkbox" checked={selection.keepChats} onChange={(e) => setSelection((s) => ({ ...s, keepChats: e.target.checked }))} aria-label={t('r12ui.dz.keepChats')} />
              <span className="st-un-grouptext">
                <span className="st-un-title">{t('r12ui.dz.keepChats')}</span>
                <small>{t('r12ui.dz.keepChatsHint')}</small>
              </span>
            </label>
          </div>
          <div className="st-un-groups">
            {plan.groups.map((g) => (
              <GroupCard key={g.id} group={g} ticked={ticked(g.id)} onToggle={(on) => toggle(g.id, on)} />
            ))}
            <div className="st-un-group is-cant" data-testid="cant">
              <div className="st-un-grouphead">
                <span className="st-un-grouptext">
                  <span className="st-un-title">{t('r12ui.dz.cantTitle')}</span>
                  <small>{t('r12ui.dz.cantHint')}</small>
                </span>
              </div>
              <ul className="st-un-cant">
                {plan.cant.map((c) => (
                  <li key={c.title}>{c.title}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="st-un-foot">
            <Btn onClick={onClose}>{t('r12ui.dz.cancel')}</Btn>
            <Btn primary onClick={() => setStep('confirm')}>
              {t('r12ui.dz.next')}
            </Btn>
          </div>
        </section>
      )}

      {step === 'confirm' && (
        <section>
          <h3>{t('r12ui.dz.sure')}</h3>
          <p className="st-un-lead" id="st-un-summary">
            {summaryLine(plan, selection)}
          </p>
          <ul className="st-un-notes">
            <li>{t('r12ui.dz.agentsKept')}</li>
            {program && <li>{t('r12ui.dz.windowsAsks')}</li>}
            <li>{chatsNote}</li>
          </ul>
          <label htmlFor="st-un-type" className="st-un-typelabel">
            {t('r12ui.dz.typeA')}<b>{CONFIRM_WORD}</b>{t('r12ui.dz.typeB')}
          </label>
          <div className="st-un-confirmbox">
            <input
              id="st-un-type"
              className="st-field is-mono"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="st-un-summary"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canGo) void start();
              }}
            />
            <Btn primary disabled={!canGo} onClick={() => void start()}>
              {allowed.allowed ? t('settings.row.uninstall-everything.label') : (allowed.reason ?? NOT_IN_DEV_TEXT)}
            </Btn>
          </div>
          {!allowed.allowed && <Note role="status">{allowed.reason ?? NOT_IN_DEV_TEXT}</Note>}
          <div className="st-un-foot">
            <Btn onClick={() => setStep('list')}>{t('r12ui.dz.back')}</Btn>
          </div>
        </section>
      )}

      {step === 'run' && (
        <section>
          <h3>{finished || everyStepDone ? t('r12ui.dz.gone') : failure ? t('r12ui.dz.stopped') : t('r12ui.dz.removing')}</h3>
          <p className="st-un-lead">
            {failure
              ? failure
              : finished || everyStepDone
                ? t('r12ui.dz.goneLead')
                : t('r12ui.dz.keepOn')}
          </p>
          <div className="st-un-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <i style={{ width: `${percent}%` }} />
          </div>
          <ul className="st-un-checks" aria-live="polite">
            {events.map((e) => (
              <li key={e.step} className={e.state === 'running' ? 'is-run' : e.state === 'failed' ? 'is-failed' : 'is-done'} data-state={e.state}>
                <span className="st-un-ic" aria-hidden="true" />
                <span>
                  {e.label}
                  {e.detail && <small>{e.detail}</small>}
                </span>
              </li>
            ))}
          </ul>
          {(finished || everyStepDone || failure) && (
            <div className="st-un-left">
              <div className="st-un-title">{t('r12ui.dz.fewCant')}</div>
              <ul>
                {plan.cant.map((c) => (
                  <li key={c.title}>
                    <b>{c.title}.</b> {c.how}
                  </li>
                ))}
              </ul>
              <small>{t('r12ui.dz.listSaved')}</small>
            </div>
          )}
          {failure && (
            <div className="st-un-foot">
              <Btn onClick={onClose}>{t('r12ui.dz.close')}</Btn>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function UninstallRow({ api = realUninstallApi }: { api?: UninstallApi }) {
  const [allowed, setAllowed] = useState<{ allowed: boolean; reason: string | null } | null>(null);
  const [plan, setPlan] = useState<UninstallPlan | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .allowed()
      .then((a) => alive && setAllowed(a))
      .catch(() => alive && setAllowed({ allowed: false, reason: NOT_IN_DEV_TEXT }));
    return () => {
      alive = false;
    };
  }, [api]);

  const openList = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api.plan());
      setOpen(true);
    } catch (e) {
      setError(t('r12ui.dz.noList', { why: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow label={t('settings.row.uninstall-everything.label')} description={t('settings.row.uninstall-everything.hint')}>
        <Btn primary={allowed?.allowed === true} disabled={busy || open} onClick={() => void openList()}>
          {busy ? t('r12ui.dz.looking') : t('r12ui.dz.uninstallBtn')}
        </Btn>
      </SettingRow>
      {allowed && !allowed.allowed && !open && <Note role="status">{allowed.reason ?? NOT_IN_DEV_TEXT}</Note>}
      {error && <Note role="alert">{error}</Note>}
      {open && plan && allowed && (
        <div className="st-row is-block">
          <div className="st-body">
            <Flow api={api} allowed={allowed} plan={plan} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Both blocks together, for a page that wants the whole Danger zone. */
export function DangerZone({ api = realUninstallApi, env }: { api?: UninstallApi; env?: Pick<SettingsEnv, 'markSaved' | 'setError'> }) {
  return (
    <div className="st-un-zone">
      <ResetRow api={api} env={env} />
      <UninstallRow api={api} />
    </div>
  );
}

/** The two rows, for the lead to place in a section (`danger` rows share one group at the end). */
export const dangerRows: RowDef[] = [
  {
    id: 'reset-settings',
    label: 'Reset settings',
    hint: RESET_HINT,
    keywords: 'reset defaults restore settings clear',
    danger: true,
    render: (env) => <ResetRow env={env} />,
  },
  {
    id: 'uninstall-everything',
    label: 'Uninstall everything',
    hint: UNINSTALL_HINT,
    keywords: 'uninstall remove delete clean remove everything leftovers',
    danger: true,
    render: () => <UninstallRow />,
  },
];
