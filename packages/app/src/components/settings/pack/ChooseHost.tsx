// "Choose settings file…": point Potato Workspace at an agent's own settings file (and, optionally, its skills folder).
// The backend reads the file, says where its server list is and what an entry looks like; the user sees the exact
// entry first, then keeps the choice. Nothing is written to the agent's files until the normal Install.
import { useState } from 'react';
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
  const entry = JSON.stringify({ 'potato-workspace': found.entry }, null, 2);
  return (
    <div data-testid="pack-inspection" className="space-y-1.5 rounded-lg border border-pm-border bg-pm-panel p-3 text-xs leading-5">
      <div className="truncate font-mono text-[11px] text-pm-muted" title={found.path}>
        {found.path}
      </div>
      <div>
        Format: <span className="font-medium">{FORMAT_NAME[found.format] ?? found.format}</span>
      </div>
      <div>
        Server list: <span className="font-mono">{found.key_path}</span>
        {found.creates_list && <span className="text-pm-muted"> (this file has none yet, so Potato Workspace adds it)</span>}
      </div>
      <div className="text-pm-muted">{found.shape}</div>
      {found.already_present ? (
        <div>A potato-workspace entry is already in this list. It is left unchanged.</div>
      ) : (
        <>
          <div>
            This entry will be added under <span className="font-mono">{found.key_path}</span>:
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
          Agent name
          <input aria-label="Agent name" className={field} value={name} maxLength={40} placeholder="For example: My agent" onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} onClick={() => void chooseFile()}>
          Choose settings file…
        </button>
        <button type="button" className={btn} onClick={() => void chooseFolder()}>
          Choose skills folder…
        </button>
        <span className="text-[11px] text-pm-muted">The skills folder is optional.</span>
      </div>
      {skills && (
        <div className="truncate font-mono text-[11px] text-pm-muted" title={skills} data-testid="pack-skills-pick">
          Skills folder: {skills}
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
              {busy ? 'Saving…' : 'Use this file'}
            </button>
          )}
          {onCancel && (
            <button type="button" className={btn} onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
