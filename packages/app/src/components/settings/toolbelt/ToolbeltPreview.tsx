// The "Apply to all agents" sheet: what will change in each agent's config, then Apply.
import { useCallback, useEffect, useState } from 'react';
import { t, useT } from '../../../i18n';
import { changeCounts, errText, type ChangeKind, type SyncHost, type SyncReport, type ToolbeltApi } from '../../../lib/toolbelt';
import { btn, btnPrimary, overlay, sheet } from './styles';

const kindText = (kind: ChangeKind): string => t(`toolbelt.kind.${kind}`);

function hostTitle(h: SyncHost): string {
  return h.agents.map((a) => a.label).join(', ');
}

function hostLine(h: SyncHost): string {
  if (h.status === 'skipped') return h.reason ?? t('pack.skipped');
  if (h.status === 'error') return h.reason ?? t('pack.wrong');
  if (h.status === 'unchanged') return t('toolbelt.upToDate');
  const n = changeCounts(h);
  return [n.add && t('toolbelt.toAdd', { n: n.add }), n.update && t('toolbelt.toUpdate', { n: n.update }), n.remove && t('toolbelt.toRemove', { n: n.remove })].filter(Boolean).join(t('preload.comma'));
}

export function ToolbeltPreview({
  api,
  projectPath,
  onClose,
  onApplied,
}: {
  api: ToolbeltApi;
  projectPath: string | null;
  onClose: () => void;
  onApplied: (summary: string) => void;
}) {
  const t = useT();
  const [report, setReport] = useState<SyncReport | null>(null);
  const [includePm, setIncludePm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setReport(await api.syncPreview({ project: projectPath, includePm }));
    } catch (e) {
      setError(errText(e));
    }
  }, [api, projectPath, includePm]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pending = report?.hosts.filter((h) => h.status === 'ready') ?? [];

  const apply = async () => {
    setBusy(true);
    try {
      const done = await api.syncApply({ project: projectPath, includePm });
      const written = done.hosts.filter((h) => h.written);
      const failed = done.hosts.filter((h) => h.status === 'error');
      const files = t('toolbelt.configFiles', { count: written.length });
      const text =
        failed.length > 0
          ? t('toolbelt.updatedFailed', { files, n: failed.length })
          : written.length === 0
            ? t('toolbelt.allUpToDate')
            : t('toolbelt.updated', { files });
      onApplied(text);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className={overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('toolbelt.apply')} className={sheet}>
        <div className="border-b border-pm-border px-4 py-3">
          <h4 className="text-sm font-semibold">{t('toolbelt.apply')}</h4>
          <p className="mt-1 text-xs leading-5 text-pm-muted">{t('toolbelt.previewHelp')}</p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <p role="alert" className="rounded-lg border border-pm-border bg-pm-bg px-3 py-2 text-xs text-pm-text">
              {error}
            </p>
          )}
          {!report && !error && <p className="text-xs text-pm-muted">{t('toolbelt.checkingEach')}</p>}
          {report?.hosts.map((h) => {
            const id = `${h.path}|${h.scope}`;
            const changed = h.changes.filter((c) => c.kind !== 'unchanged');
            return (
              <div key={id} data-testid="toolbelt-host" className="rounded-lg border border-pm-border bg-pm-bg">
                <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 pt-2.5">
                  <span className="text-sm font-medium">{hostTitle(h)}</span>
                  <span className="text-xs text-pm-muted">{hostLine(h)}</span>
                </div>
                <div className="truncate px-3 pb-2 font-mono text-[11px] text-pm-muted" title={h.path}>
                  {h.path}
                  {h.scope === 'project' ? ` ${t('toolbelt.thisProjectParen')}` : ''}
                </div>
                {changed.length > 0 && (
                  <ul className="border-t border-pm-border px-3 py-2 text-xs">
                    {changed.map((c) => (
                      <li key={c.key} className="flex gap-2 py-0.5">
                        <span className="w-14 shrink-0 text-pm-muted">{kindText(c.kind)}</span>
                        <span className="truncate">{c.name}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {h.notes.map((n) => (
                  <p key={n} className="border-t border-pm-border px-3 py-2 text-xs text-pm-muted">
                    {n}
                  </p>
                ))}
                {h.diff && (
                  <div className="border-t border-pm-border px-3 py-2">
                    <button
                      type="button"
                      className="text-xs text-pm-muted underline"
                      aria-expanded={open === id}
                      onClick={() => setOpen(open === id ? null : id)}
                    >
                      {open === id ? t('toolbelt.hideChanges') : t('toolbelt.showChanges')}
                    </button>
                    {open === id && (
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-pm-panel p-2 font-mono text-[11px] leading-5">
                        {h.diff}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {report && report.unsupported.length > 0 && (
            <div className="rounded-lg border border-pm-border bg-pm-bg px-3 py-2.5" data-testid="toolbelt-unsupported">
              <div className="text-sm font-medium">{t('toolbelt.notSupportedTitle')}</div>
              <ul className="mt-1 space-y-1 text-xs text-pm-muted">
                {report.unsupported.map((u) => (
                  <li key={u.id}>
                    <span className="text-pm-text">{u.label}</span>: {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-pm-muted">
            <input type="checkbox" checked={includePm} onChange={(e) => setIncludePm(e.target.checked)} />
            {t('toolbelt.alsoRegister')}
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-pm-border px-4 py-3">
          <span className="text-xs text-pm-muted">
            {report ? (pending.length === 0 ? t('toolbelt.nothingToChange') : t('toolbelt.filesWillChange', { count: pending.length })) : ''}
          </span>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={onClose}>
              {t('lend.cancel')}
            </button>
            <button type="button" className={btnPrimary} onClick={() => void apply()} disabled={busy || pending.length === 0}>
              {busy ? t('toolbelt.applying') : t('toolbelt.applyBtn')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
