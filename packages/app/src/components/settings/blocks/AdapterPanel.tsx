// The keys and settings a reviewed adapter asks for, inside "Add chat". A key row says Saved or Not saved (from
// `acp_adapter_key_status`, names and yes/no only). An unsaved key gets a password box; "Save key" sends the typed value
// once and clears the box at once, so the value is never kept in React state. A key kept in Keys settings is only
// pointed at there. Settings are plain text, starting at their public defaults. Reports ready/names/settings upward.
import { useEffect, useRef, useState } from 'react';
import { errorSentence, type AcpChatApi, type AdapterKeyRow, type AdapterKeyStatus, type AdapterSettingRow } from '../../../lib/acpChat';
import { missingKeysLine, preferredValue, settingDefaults } from '../../../lib/acpAdapter';
import { BTN } from './AgentWizardCapture';

export type AdapterPanelApi = Pick<AcpChatApi, 'adapterKeyStatus' | 'adapterKeySet'>;

/** What the panel reports: `ready` when every key group has a saved key; the names to approve and the setting values. */
export interface AdapterReport {
  ready: boolean;
  approved_keys: string[];
  settings: Record<string, string>;
}

const INPUT = 'min-w-0 flex-1 rounded border border-pm-border bg-pm-bg px-2 py-1 text-sm text-pm-text';

export function AdapterPanel({
  adapterId,
  keys,
  settings,
  groups,
  api,
  onReport,
}: {
  adapterId: string;
  keys: AdapterKeyRow[];
  settings: AdapterSettingRow[];
  /** Each group needs one of its keys saved. Pass a stable array (the report runs when it changes). */
  groups: string[][];
  api: AdapterPanelApi;
  onReport: (report: AdapterReport) => void;
}) {
  const [statuses, setStatuses] = useState<AdapterKeyStatus[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() => settingDefaults(settings));
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The password boxes, by variable name. Read once on save, then cleared. */
  const boxes = useRef<Record<string, HTMLInputElement | null>>({});
  const report = useRef(onReport);
  report.current = onReport;

  const load = async () => {
    if (!api.adapterKeyStatus) {
      setError('This version of the app cannot save adapter keys.');
      return;
    }
    try {
      setStatuses(await api.adapterKeyStatus(adapterId));
    } catch (e) {
      setError(errorSentence(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterId]);

  // Once the key statuses are known, each setting with choices starts at the first choice whose key is saved.
  const preselected = useRef(false);
  useEffect(() => {
    if (!statuses || preselected.current) return;
    preselected.current = true;
    setValues((prev) => ({ ...prev, ...Object.fromEntries(settings.filter((s) => s.options?.length).map((s) => [s.env, preferredValue(s, statuses)])) }));
  }, [statuses, settings]);

  useEffect(() => {
    const list = statuses ?? [];
    report.current({
      ready: statuses !== null && missingKeysLine(groups, list, keys) === null,
      approved_keys: keys.map((k) => k.env),
      settings: values,
    });
  }, [statuses, values, groups, keys]);

  const save = async (env: string) => {
    const box = boxes.current[env];
    const value = (box?.value ?? '').trim();
    if (!value || !api.adapterKeySet) {
      setError('Type the key first.');
      return;
    }
    setSaving(env);
    setError(null);
    try {
      await api.adapterKeySet(adapterId, env, value);
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      if (box) box.value = '';
      setSaving(null);
    }
    await load();
  };

  const missing = statuses ? missingKeysLine(groups, statuses, keys) : null;

  return (
    <div data-testid="adapter-panel" className="mt-3 space-y-3">
      {keys.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-pm-muted">The keys this adapter may receive. Only the names shown here are passed on.</p>
          {keys.map((k) => {
            const st = statuses?.find((s) => s.env === k.env);
            return (
              <div key={k.env} data-testid={`adapter-key-${k.env}`} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{k.label}</span>
                  <code className="font-mono text-xs text-pm-muted">{k.env}</code>
                  <span data-testid={`adapter-key-state-${k.env}`} className="text-xs text-pm-muted">
                    {st ? (st.set ? 'Saved' : 'Not saved') : 'Checking...'}
                  </span>
                </div>
                {st && !st.set && st.shared && <p className="mt-1 text-xs text-pm-muted">Add it in Keys settings, then come back here.</p>}
                {st && !st.set && !st.shared && (
                  <div className="mt-1 flex gap-2">
                    <input
                      ref={(el) => {
                        boxes.current[k.env] = el;
                      }}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`${k.label} key`}
                      data-testid={`adapter-key-input-${k.env}`}
                      className={INPUT}
                    />
                    <button type="button" className={BTN} disabled={saving !== null} onClick={() => void save(k.env)} data-testid={`adapter-key-save-${k.env}`}>
                      Save key
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {settings.map((s) => (
        <div key={s.env} className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-pm-muted">{s.label}</span>
          {s.options && s.options.length > 0 && (
            <select
              aria-label={`${s.label} choice`}
              data-testid={`adapter-setting-pick-${s.env}`}
              value={s.options.some((o) => o.value === values[s.env]) ? values[s.env] : ''}
              onChange={(e) => e.target.value && setValues((prev) => ({ ...prev, [s.env]: e.target.value }))}
              className={INPUT}
            >
              {!s.options.some((o) => o.value === values[s.env]) && <option value="">Another model (type it below)</option>}
              {s.options.map((o) => {
                const saved = !o.needs_key || (statuses ?? []).some((st) => st.env === o.needs_key && st.set);
                return (
                  <option key={o.value} value={o.value}>
                    {saved ? o.label : `${o.label} (needs ${o.needs_key} saved)`}
                  </option>
                );
              })}
            </select>
          )}
          <input
            type="text"
            spellCheck={false}
            aria-label={`${s.label} value`}
            value={values[s.env] ?? ''}
            data-testid={`adapter-setting-${s.env}`}
            onChange={(e) => setValues((prev) => ({ ...prev, [s.env]: e.target.value }))}
            className={INPUT}
          />
        </div>
      ))}
      {missing && (
        <p data-testid="adapter-missing" className="text-xs text-pm-text">
          {missing}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-pm-text">
          {error}
        </p>
      )}
    </div>
  );
}
