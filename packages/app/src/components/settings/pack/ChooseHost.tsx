// "Choose settings file…": point Potato Workspace at an agent's own settings file (and, optionally, its skills folder).
// The backend reads the file, says where its server list is and what an entry looks like; the user sees the exact
// entry first, then keeps the choice. Nothing is written to the agent's files until the normal Install.
import { useState } from 'react';
import { t, useT } from '../../../i18n';
import type { AgentPackApi, PackInspection } from '../../../lib/agent-pack';
import { errText } from '../../../lib/toolbelt';
import { btn, btnPrimary, field } from '../toolbelt/styles';

const FORMAT_NAME: Record<string, string> = { json: 'JSON', toml: 'TOML', yaml: 'YAML' };

export interface HostTarget {
  /** A listed agent's id; absent for an agent Potato Workspace doesn't know. */
  agentId?: string;
  label?: string;
}

export function InspectionCard({ found }: { found: PackInspection }) {
  const t = useT();
  const entry = JSON.stringify({ 'potato-workspace': found.entry }, null, 2);
  return (
    <div data-testid="pack-inspection" className="space-y-1.5 rounded-lg border border-pm-border bg-pm-panel p-3 text-xs leading-5">
      <div className="truncate font-mono text-[11px] text-pm-muted" title={found.path}>
        {found.path}
      </div>
      <div>
        {t('pack.format')} <span className="font-medium">{FORMAT_NAME[found.format] ?? found.format}</span>
      </div>
      <div>
        {t('pack.serverList')} <span className="font-mono">{found.key_path}</span>
        {found.creates_list && <span className="text-pm-muted"> {t('pack.createsList')}</span>}
      </div>
      <div className="text-pm-muted">{found.shape}</div>
      {found.already_present ? (
        <div>{t('pack.alreadyIn')}</div>
      ) : (
        <>
          <div>
            {t('pack.willBeAdded')} <span className="font-mono">{found.key_path}</span>:
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-pm-bg p-2 font-mono text-[11px] leading-5">{entry}</pre>
        </>
      )}
    </div>
  );
}

export function ChooseHost({
  api,
  target,
  askName,
  onSaved,
  onCancel,
}: {
  api: AgentPackApi;
  target: HostTarget;
  /** Ask for a display name first (an agent Potato Workspace doesn't know). */
  askName?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [found, setFound] = useState<PackInspection | null>(null);
  const [skills, setSkills] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chooseFile = async () => {
    try {
      const path = await api.pickFile();
      if (!path) return;
      setFound(await api.inspect(path));
      setError(null);
    } catch (e) {
      setFound(null);
      setError(errText(e));
    }
  };

  const chooseFolder = async () => {
    try {
      const path = await api.pickFolder();
      if (path) setSkills(path);
    } catch (e) {
      setError(errText(e));
    }
  };

  const save = async () => {
    if (!found) return;
    setBusy(true);
    try {
      await api.saveCustom({ agent_id: target.agentId, name: askName ? name.trim() : undefined, path: found.path, skills_dir: skills ?? undefined });
      onSaved();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  const nameMissing = !!askName && name.trim() === '';

  return (
    <div data-testid="pack-choose" className="mt-2 space-y-2">
      {askName && (
        <label className="block text-xs text-pm-muted">
          {t('pack.agentName')}
          <input aria-label={t('pack.agentName')} className={field} value={name} maxLength={40} placeholder={t('pack.agentNamePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => void chooseFile()}>
          {t('pack.chooseFile')}
        </button>
        <button type="button" className={btn} onClick={() => void chooseFolder()}>
          {t('pack.chooseFolder')}
        </button>
        <span className="text-[11px] text-pm-muted">{t('pack.folderOptional')}</span>
      </div>
      {skills && (
        <div className="truncate font-mono text-[11px] text-pm-muted" title={skills} data-testid="pack-skills-pick">
          {t('pack.skillsFolder', { path: skills })}
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-pm-border bg-pm-bg px-3 py-2 text-xs text-pm-text">
          {error}
        </p>
      )}
      {found && <InspectionCard found={found} />}
      {(found || onCancel) && (
        <div className="flex gap-2">
          {found && (
            <button type="button" className={btnPrimary} disabled={busy || nameMissing} onClick={() => void save()}>
              {busy ? t('tunnel.saving') : t('pack.useFile')}
            </button>
          )}
          {onCancel && (
            <button type="button" className={btn} onClick={onCancel}>
              {t('lend.cancel')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
