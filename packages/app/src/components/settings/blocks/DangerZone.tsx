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
      setError(`Not reset: ${errorText(e)}`);
      env?.setError(`Not reset: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow label="Reset settings" description={RESET_HINT}>
        <Btn
          disabled={asking || busy}
          onClick={() => {
            setDone(false);
            setAsking(true);
          }}
        >
          Reset…
        </Btn>
      </SettingRow>
      {asking && (
        <div className="st-row" role="group" aria-label="Confirm reset">
          <div className="st-label">
            <span>Are you sure?</span>
            <small>Reset all settings now?</small>
          </div>
          <div className="st-control">
            <Btn onClick={() => setAsking(false)} disabled={busy}>
              Cancel
            </Btn>
            <Btn primary onClick={() => void reset()} disabled={busy}>
              {busy ? 'Resetting…' : 'Reset settings'}
            </Btn>
          </div>
        </div>
      )}
      {done && <Note role="status">Settings reset. Agents and chats kept.</Note>}
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
          <summary>Show what</summary>
          <ul>
            {shown.map((item, i) => (
              <li key={`${item.label}-${i}`}>{item.label}</li>
            ))}
            {more > 0 && <li className="st-un-more">{`+ ${more} more`}</li>}
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
  const chatsNote = selection.keepChats ? 'Your chats are saved to Documents first.' : chatsGroup && ticked('chats') ? 'Your chats will be deleted.' : 'Your chats stay where they are.';
  const canGo = typed.trim().toUpperCase() === CONFIRM_WORD && allowed.allowed;

  const total = events[0]?.total ?? 0;
  const doneCount = events.filter((e) => e.state === 'done' || e.state === 'skipped').length;
  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const everyStepDone = total > 0 && doneCount >= total;

  return (
    <div className="st-un-flow">
      <ol className="st-un-steps" aria-label="Uninstall steps">
        {(['Check the list', 'Confirm', 'Remove'] as const).map((name, i) => {
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
          <h3>Uninstall everything</h3>
          <p className="st-un-lead">Here is everything we found. Untick what you want to keep.</p>
          <div className="st-un-group st-un-keepchats">
            <label className="st-un-grouphead">
              <input type="checkbox" checked={selection.keepChats} onChange={(e) => setSelection((s) => ({ ...s, keepChats: e.target.checked }))} aria-label="Keep my chats" />
              <span className="st-un-grouptext">
                <span className="st-un-title">Keep my chats</span>
                <small>Saves your chats as one zip in Documents first.</small>
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
                  <span className="st-un-title">We can't remove these for you</span>
                  <small>We'll show you how at the end.</small>
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
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn primary onClick={() => setStep('confirm')}>
              Next
            </Btn>
          </div>
        </section>
      )}

      {step === 'confirm' && (
        <section>
          <h3>Are you sure?</h3>
          <p className="st-un-lead" id="st-un-summary">
            {summaryLine(plan, selection)}
          </p>
          <ul className="st-un-notes">
            <li>Your agents keep their own settings. We back them up first.</li>
            {program && <li>Windows will ask you once to allow removing the program.</li>}
            <li>{chatsNote}</li>
          </ul>
          <label htmlFor="st-un-type" className="st-un-typelabel">
            Type <b>{CONFIRM_WORD}</b> to continue
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
              {allowed.allowed ? 'Uninstall everything' : (allowed.reason ?? NOT_IN_DEV_TEXT)}
            </Btn>
          </div>
          {!allowed.allowed && <Note role="status">{allowed.reason ?? NOT_IN_DEV_TEXT}</Note>}
          <div className="st-un-foot">
            <Btn onClick={() => setStep('list')}>Back</Btn>
          </div>
        </section>
      )}

      {step === 'run' && (
        <section>
          <h3>{finished || everyStepDone ? 'Potato Workspace is gone' : failure ? 'Stopped' : 'Removing Potato Workspace…'}</h3>
          <p className="st-un-lead">
            {failure
              ? failure
              : finished || everyStepDone
                ? 'Everything we added is removed. Thanks for trying it.'
                : 'Please keep your PC on. This takes about a minute.'}
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
              <div className="st-un-title">A few things we can't remove for you</div>
              <ul>
                {plan.cant.map((c) => (
                  <li key={c.title}>
                    <b>{c.title}.</b> {c.how}
                  </li>
                ))}
              </ul>
              <small>The full list is saved in a text file.</small>
            </div>
          )}
          {failure && (
            <div className="st-un-foot">
              <Btn onClick={onClose}>Close</Btn>
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
      setError(`Could not make the list: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow label="Uninstall everything" description={UNINSTALL_HINT}>
        <Btn primary={allowed?.allowed === true} disabled={busy || open} onClick={() => void openList()}>
          {busy ? 'Looking…' : 'Uninstall…'}
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
