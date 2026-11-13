// Settings > Labs > Assign an issue: the sheet that adds or edits one watched repository. The folder is checked
// first (its GitHub remote must be exactly that repository). The agent list has ready agents only. Saving hands
// the new repository to the parent, which writes the whole config through `intakeSave` (the backend checks it too).
import { useEffect, useState } from 'react';
import { t, useT } from '../../../i18n';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useAgentRegistry, type AgentDescriptor } from '../../../lib/agentRegistry';
import { intakeCheckFolder, type FolderCheck, type RepoWatch } from '../../../lib/issue-intake';
import { Btn, FieldInput, FieldSelect, Note, SettingRow, SettingToggle } from '../settings-ui';

export const DEFAULT_LABEL = 'puppet';
/** An example path in the empty field: the same in every language. */
const EXAMPLE_FOLDER = 'C:\\work\\my-project';
export const TURNS = { min: 1, max: 200, value: 30 };
export const MINUTES = { min: 5, max: 240, value: 45 };
export const RUNS_A_DAY = { min: 1, max: 50, value: 5 };
/** Most repositories one person can watch (the backend checks it too). */
export const REPOS_CAP = 20;

const LABEL_RE = /^[A-Za-z0-9 _.:-]{1,50}$/;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Agents that can start an issue run: they run delegated work, are installed, and open a visible pane. */
export function readyAgents(agents: AgentDescriptor[]): AgentDescriptor[] {
  return agents.filter((a) => a.dispatchable && a.installed && a.modes.visible);
}

/** Plain error for a label, or null when it is fine. Letters, numbers, spaces and _ . : - only. */
export function labelError(label: string): string | null {
  return LABEL_RE.test(label.trim()) ? null : t('repo.labelError');
}

/** Plain error for a whole-number field, or null when it is in range. */
export function countError(text: string, what: string, range: { min: number; max: number }): string | null {
  const trimmed = text.trim();
  const n = Number(trimmed);
  if (trimmed !== '' && Number.isInteger(n) && n >= range.min && n <= range.max) return null;
  return t('repo.countError', { what, min: range.min, max: range.max });
}

/** A new watched-repo id: "rw-" and 8 lowercase hex digits (the backend checks the shape). */
export function newRepoId(random: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 8; i++) hex += Math.floor(random() * 16).toString(16);
  return `rw-${hex}`;
}

/** What the form holds. Numbers stay text until they are checked. */
export interface RepoForm {
  label: string;
  agent: string;
  turns: string;
  minutes: string;
  runsPerDay: string;
  askBeforeStart: boolean;
  askBeforePush: boolean;
}

export const DEFAULT_FORM: RepoForm = {
  label: DEFAULT_LABEL,
  agent: '',
  turns: String(TURNS.value),
  minutes: String(MINUTES.value),
  runsPerDay: String(RUNS_A_DAY.value),
  askBeforeStart: true,
  askBeforePush: true,
};

export type BuildResult = { repo: RepoWatch } | { error: string };

/**
 * The repository the form describes, or the first plain reason it cannot be saved. Pure: no calls.
 * `check` must be the folder check of `folder` (the caller drops a check made for another folder).
 */
export function buildRepo(input: {
  folder: string;
  form: RepoForm;
  check: FolderCheck | null;
  existing: RepoWatch[];
  editing: RepoWatch | null;
}): BuildResult {
  const { folder, form, check, existing, editing } = input;
  const owner = check?.owner_repo;
  if (!owner || check?.why_not) return { error: check?.why_not ?? t('repo.pickClone') };
  if (existing.some((r) => r.owner_repo === owner && r.id !== editing?.id)) return { error: t('repo.already', { owner }) };
  if (!editing && existing.length >= REPOS_CAP) return { error: t('repo.cap', { n: REPOS_CAP }) };
  const label = labelError(form.label);
  if (label) return { error: label };
  const turns = countError(form.turns, t('repo.turns'), TURNS);
  if (turns) return { error: turns };
  const minutes = countError(form.minutes, t('repo.minutes'), MINUTES);
  if (minutes) return { error: minutes };
  const runs = countError(form.runsPerDay, t('repo.runs'), RUNS_A_DAY);
  if (runs) return { error: runs };
  if (!form.agent) return { error: t('repo.pickAgent') };
  return {
    repo: {
      id: editing?.id ?? newRepoId(),
      owner_repo: owner,
      folder: folder.trim(),
      label: form.label.trim(),
      agent: { agent_type: form.agent, account: null },
      turns: Number(form.turns),
      minutes: Number(form.minutes),
      runs_per_day: Number(form.runsPerDay),
      ask_before_start: form.askBeforeStart,
      ask_before_push: form.askBeforePush,
      // A new repository gets its baseline from the backend (the time it is saved). Edits keep theirs.
      added_at_ms: editing?.added_at_ms ?? 0,
      paused: editing?.paused ?? false,
    },
  };
}

/** The sheet itself. `onSave` rejects with the message to show; a resolved save is the parent's to close. */
export function AddRepoSheet({
  editing,
  repos,
  projectPath,
  onSave,
  onCancel,
}: {
  editing: RepoWatch | null;
  repos: RepoWatch[];
  projectPath: string | null;
  onSave: (repo: RepoWatch) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const agents = readyAgents(useAgentRegistry().agents);
  const [folder, setFolder] = useState(editing?.folder ?? projectPath ?? '');
  const [form, setForm] = useState<RepoForm>(() =>
    editing
      ? {
          ...DEFAULT_FORM,
          label: editing.label,
          agent: editing.agent.agent_type,
          turns: String(editing.turns),
          minutes: String(editing.minutes),
          runsPerDay: String(editing.runs_per_day),
          askBeforeStart: editing.ask_before_start,
          askBeforePush: editing.ask_before_push,
        }
      : DEFAULT_FORM,
  );
  const [check, setCheck] = useState<{ folder: string; result: FolderCheck } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The agent shown: the chosen one when it is ready; else the first ready agent (a new repo) or none (an edit
  // whose agent is no longer ready, so the person must pick another).
  const chosen = agents.some((a) => a.id === form.agent) ? form.agent : editing ? '' : (agents[0]?.id ?? '');
  const shown = check && check.folder === folder.trim() ? check.result : null;

  // Check the folder once on open (an edit, or the project folder a new repo starts with). Later checks run on
  // blur, on Browse and on "Use project folder".
  useEffect(() => {
    if (folder.trim()) void runCheck(folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof RepoForm>(key: K, value: RepoForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const runCheck = async (value: string) => {
    const path = value.trim();
    if (!path) {
      setCheck(null);
      return;
    }
    setChecking(true);
    try {
      setCheck({ folder: path, result: await intakeCheckFolder(path) });
    } catch (e) {
      setCheck({ folder: path, result: { owner_repo: null, default_branch: null, gh: '', why_not: errText(e) } });
    } finally {
      setChecking(false);
    }
  };

  const browse = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false, defaultPath: folder.trim() || projectPath || undefined });
      if (typeof picked === 'string') {
        setFolder(picked);
        await runCheck(picked);
      }
    } catch (e) {
      setError(errText(e));
    }
  };

  const save = async () => {
    const built = buildRepo({ folder, form: { ...form, agent: chosen }, check: shown, existing: repos, editing });
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(built.repo);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  let detected = t('repo.pickFolder');
  if (checking) detected = t('repo.checking');
  else if (shown?.why_not) detected = shown.why_not;
  else if (shown?.owner_repo) detected = shown.default_branch ? t('repo.foundBranch', { repo: shown.owner_repo, branch: shown.default_branch }) : t('repo.found', { repo: shown.owner_repo });

  return (
    <div
      className="st-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="st-sheet" role="dialog" aria-modal="true" aria-labelledby="st-repo-title">
        <h2 id="st-repo-title">{editing ? t('repo.edit') : t('repo.add')}</h2>
        <p>{t('repo.intro')}</p>

        <SettingRow label={t('repo.folder')} description={t('repo.folderHelp')}>
          <div className="st-number">
            <FieldInput
              aria-label={t('repo.folder')}
              className="font-mono"
              value={folder}
              placeholder={EXAMPLE_FOLDER}
              onChange={(e) => setFolder(e.target.value)}
              onBlur={() => void runCheck(folder)}
            />
            <Btn small onClick={() => void browse()}>
              {t('general.browse')}
            </Btn>
          </div>
        </SettingRow>
        {projectPath && folder !== projectPath && (
          <Btn small onClick={() => { setFolder(projectPath); void runCheck(projectPath); }}>
            {t('repo.useProject')}
          </Btn>
        )}
        <Note role={shown?.why_not ? 'alert' : 'status'}>{detected}</Note>
        {shown && !shown.why_not && shown.gh && shown.gh !== 'ready' && (
          <Note>{t('repo.ghInstall')}</Note>
        )}

        <SettingRow label={t('repo.label')} description={t('repo.labelHelp')}>
          <FieldInput aria-label={t('repo.label')} value={form.label} onChange={(e) => set('label', e.target.value)} />
        </SettingRow>

        <SettingRow label={t('lend.request.agent')} description={t('repo.agentHelp')}>
          <FieldSelect aria-label={t('lend.request.agent')} value={chosen} disabled={agents.length === 0} onChange={(e) => set('agent', e.target.value)}>
            {chosen === '' && <option value="">{t('keepGoing.choose')}</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label || a.id}
              </option>
            ))}
          </FieldSelect>
        </SettingRow>
        {agents.length === 0 && <Note>{t('repo.noAgent')}</Note>}

        <SettingRow label={t('repo.turns')} description={t('repo.turnsHelp', { min: TURNS.min, max: TURNS.max })}>
          <FieldInput aria-label={t('repo.turns')} type="number" min={TURNS.min} max={TURNS.max} value={form.turns} onChange={(e) => set('turns', e.target.value)} />
        </SettingRow>
        <SettingRow label={t('repo.minutes')} description={t('repo.minutesHelp', { min: MINUTES.min, max: MINUTES.max })}>
          <FieldInput aria-label={t('repo.minutes')} type="number" min={MINUTES.min} max={MINUTES.max} value={form.minutes} onChange={(e) => set('minutes', e.target.value)} />
        </SettingRow>
        <SettingRow label={t('repo.runs')} description={t('repo.runsHelp', { min: RUNS_A_DAY.min, max: RUNS_A_DAY.max })}>
          <FieldInput aria-label={t('repo.runs')} type="number" min={RUNS_A_DAY.min} max={RUNS_A_DAY.max} value={form.runsPerDay} onChange={(e) => set('runsPerDay', e.target.value)} />
        </SettingRow>

        <SettingToggle
          label={t('repo.askStart')}
          description={t('repo.askStartHelp')}
          checked={form.askBeforeStart}
          onChange={(on) => set('askBeforeStart', on)}
        />
        <SettingToggle
          label={t('repo.askPush')}
          description={t('repo.askPushHelp')}
          checked={form.askBeforePush}
          onChange={(on) => set('askBeforePush', on)}
        />

        {error && <Note role="alert">{error}</Note>}
        <div className="st-sheet-actions">
          <Btn disabled={busy} onClick={onCancel}>
            {t('lend.cancel')}
          </Btn>
          <Btn primary disabled={busy} onClick={() => void save()}>
            {editing ? t('discord.save') : t('repo.addBtn')}
          </Btn>
        </div>
      </div>
    </div>
  );
}
