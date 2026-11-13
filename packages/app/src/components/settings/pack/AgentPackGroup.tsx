// Settings > Helpers > "Let agents ask each other for help": install the skills and the connection into
// each agent that is on this computer. Review first, then install; Undo puts every file back.
import { useCallback, useEffect, useState } from 'react';
import { t, useT } from '../../../i18n';
import {
  agentPackApi,
  groupAgents,
  pendingCount,
  visibleRows,
  type AgentPackApi,
  type FileKind,
  type PackReport,
  type PackRow,
  type UndoReport,
} from '../../../lib/agent-pack';
import { errText } from '../../../lib/toolbelt';
import { ChooseHost } from './ChooseHost';
import { btn, btnPrimary, overlay, sheet } from '../toolbelt/styles';

const fileText = (kind: FileKind): string => t(`pack.file.${kind}`);

function names(row: PackRow): string {
  return row.labels.join(', ');
}

function skillsLine(row: PackRow): string {
  const s = row.skills;
  if (!s) return '';
  if (s.status === 'skipped') return s.reason ?? t('pack.skipped');
  if (s.status === 'error') return s.reason ?? t('pack.wrong');
  if (s.status === 'unchanged') return t('pack.skillsInstalled');
  const n = s.files.filter((f) => f.kind !== 'unchanged').length;
  const replaced = s.files.some((f) => f.kind === 'replace');
  return t('pack.skillsToAdd', { count: n, extra: replaced ? t('pack.oneReplaces') : '' });
}

function mcpLine(row: PackRow): string {
  const m = row.mcp;
  if (!m) return '';
  if (m.status === 'skipped') return m.reason ?? t('pack.skipped');
  if (m.status === 'error') return m.reason ?? t('pack.wrong');
  if (m.status === 'unchanged') return t('pack.connected');
  if (m.change === 'update') return t('pack.fixConnection');
  return t('pack.willAdd');
}

export function PackSheet({
  api,
  onClose,
  onDone,
  onChanged,
}: {
  api: AgentPackApi;
  onClose: () => void;
  onDone: (text: string, report: PackReport) => void;
  /** The user's own settings files changed (saved or forgotten). */
  onChanged?: () => void;
}) {
  const t = useT();
  const [report, setReport] = useState<PackReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [other, setOther] = useState(false);

  const reload = useCallback(() => {
    api.preview().then(
      (r) => {
        setReport(r);
        setError(null);
      },
      (e) => setError(errText(e)),
    );
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  const changed = () => {
    setOther(false);
    reload();
    onChanged?.();
  };

  const forget = async (id: string) => {
    try {
      await api.forgetCustom(id);
      changed();
    } catch (e) {
      setError(errText(e));
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grouped = report ? groupAgents(report.agents) : [];
  const rows = visibleRows(grouped);
  const absent = grouped.filter((r) => !rows.includes(r));
  const unsupported = report?.unsupported ?? [];
  const chosen = report?.custom ?? [];
  const pending = pendingCount(rows);

  const install = async () => {
    setBusy(true);
    try {
      const done = await api.apply();
      const written = visibleRows(groupAgents(done.agents)).filter((r) => r.skills?.written || r.mcp?.written);
      const failed = done.agents.filter((a) => a.skills?.status === 'error' || a.mcp?.status === 'error');
      const where = written.map(names).join(', ');
      const text =
        written.length === 0
          ? t('pack.everyHas')
          : t('pack.addedTo', { where, failed: failed.length > 0 ? ` ${t('pack.couldNotWrite', { n: failed.length })}` : '' });
      onDone(text, done);
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };

  return (
    <div className={overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('settings.row.agent-pack.label')} className={sheet}>
        <div className="border-b border-pm-border px-4 py-3">
          <h4 className="text-sm font-semibold">{t('settings.row.agent-pack.label')}</h4>
          <p className="mt-1 text-xs leading-5 text-pm-muted">{t('pack.sheetHelp')}</p>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {error && (
            <p role="alert" className="rounded-lg border border-pm-border bg-pm-bg px-3 py-2 text-xs text-pm-text">
              {error}
            </p>
          )}
          {!report && !error && <p className="text-xs text-pm-muted">{t('pack.looking')}</p>}
          {rows.map((row) => (
            <div key={row.key} data-testid="pack-agent" className="rounded-lg border border-pm-border bg-pm-bg">
              <div className="px-3 pt-2.5 text-sm font-medium">{names(row)}</div>
              <dl className="space-y-1 px-3 py-2 text-xs">
                {row.skills && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-pm-muted">{t('pack.skills')}</dt>
                    <dd className="min-w-0">
                      <div>{skillsLine(row)}</div>
                      <div className="truncate font-mono text-[11px] text-pm-muted" title={row.skills.path}>
                        {row.skills.path}
                      </div>
                      {open === `${row.key}|skills` &&
                        row.skills.files.map((f) => (
                          <div key={f.name} className="font-mono text-[11px] text-pm-muted">
                            {f.name} · {fileText(f.kind)}
                          </div>
                        ))}
                    </dd>
                  </div>
                )}
                {row.mcp && (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-pm-muted">{t('pack.connection')}</dt>
                    <dd className="min-w-0">
                      <div>{mcpLine(row)}</div>
                      <div className="truncate font-mono text-[11px] text-pm-muted" title={row.mcp.path}>
                        {row.mcp.path}
                      </div>
                      {open === `${row.key}|mcp` && row.mcp.diff && (
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-pm-panel p-2 font-mono text-[11px] leading-5">
                          {row.mcp.diff}
                        </pre>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {chosen
                .filter((c) => row.ids.includes(c.id))
                .map((c) => (
                  <div key={c.id} data-testid="pack-chosen" className="flex items-center justify-between gap-2 border-t border-pm-border px-3 py-2 text-xs">
                    <span className="min-w-0 truncate text-pm-muted" title={c.config_path}>
                      {t('pack.chosenFile')} <span className="font-mono text-[11px]">{c.config_path}</span> ({c.format.toUpperCase()}, {c.key_path})
                    </span>
                    <button type="button" className="shrink-0 text-xs text-pm-muted underline" onClick={() => void forget(c.id)}>
                      {t('pack.forget')}
                    </button>
                  </div>
                ))}
              <div className="border-t border-pm-border px-3 py-2">
                <button
                  type="button"
                  className="text-xs text-pm-muted underline"
                  aria-expanded={open?.startsWith(row.key) ?? false}
                  onClick={() => setOpen(open?.startsWith(row.key) ? null : `${row.key}|${row.mcp?.diff ? 'mcp' : 'skills'}`)}
                >
                  {open?.startsWith(row.key) ? t('pack.hideDetails') : t('pack.showDetails')}
                </button>
              </div>
            </div>
          ))}
          {report && rows.length === 0 && <p className="text-xs text-pm-muted">{t('pack.noneFound')}</p>}
          {absent.length > 0 && (
            <p className="text-xs leading-5 text-pm-muted" data-testid="pack-absent">
              {t('pack.notHere', { names: absent.map(names).join(', ') })}
            </p>
          )}
          {unsupported.map((u) => (
            <div key={u.id} data-testid="pack-unsupported-row">
              <p className="text-xs leading-5 text-pm-muted" data-testid="pack-unsupported">
                {t('pack.cantYet', { label: u.label, reason: u.reason?.trim() ? u.reason.trim().replace(/\.$/, '') : t('pack.unsupportedReason') })}
              </p>
              <ChooseHost api={api} target={{ agentId: u.id, label: u.label }} onSaved={changed} />
            </div>
          ))}
          {report && (
            <div data-testid="pack-other">
              {other ? (
                <ChooseHost api={api} target={{}} askName onSaved={changed} onCancel={() => setOther(false)} />
              ) : (
                <button type="button" className="text-xs text-pm-muted underline" onClick={() => setOther(true)}>
                  {t('pack.otherAgent')}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-pm-border px-4 py-3">
          <span className="text-xs text-pm-muted">
            {report ? (pending === 0 ? t('pack.nothingToAdd') : t('pack.willChange', { count: pending })) : ''}
          </span>
          <div className="flex gap-2">
            <button type="button" className={btn} onClick={onClose}>
              {t('lend.cancel')}
            </button>
            <button type="button" className={btnPrimary} onClick={() => void install()} disabled={busy || pending === 0}>
              {busy ? t('pack.installing') : t('agentPage.install')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentPackGroup({ api = agentPackApi }: { api?: AgentPackApi }) {
  const t = useT();
  const [reviewing, setReviewing] = useState(false);
  const [recorded, setRecorded] = useState(0);
  const [found, setFound] = useState<string[] | null>(null);
  const [cantSetUp, setCantSetUp] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.preview();
      setRecorded(r.recorded);
      setFound(visibleRows(groupAgents(r.agents)).filter((x) => x.installed).map(names));
      setCantSetUp((r.unsupported ?? []).filter((u) => u.installed).map((u) => u.label));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const undo = async () => {
    setUndoing(true);
    try {
      const u: UndoReport = await api.undo();
      const n = u.removed.length + u.restored.length;
      setNotice(
        u.skipped.length > 0
          ? t('pack.undoneSkipped', { count: n, skipped: u.skipped.length })
          : t('pack.undone', { count: n }),
      );
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <section aria-label={t('settings.row.agent-pack.label')} className="rounded-xl border border-pm-border bg-pm-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{t('settings.row.agent-pack.label')}</h3>
          <p className="mt-1 max-w-xl text-sm leading-6 text-pm-muted">{t('pack.groupHelp')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {recorded > 0 && (
            <button type="button" className={btn} onClick={() => void undo()} disabled={undoing}>
              {undoing ? t('pack.undoing') : t('pack.undo')}
            </button>
          )}
          <button type="button" className={btnPrimary} onClick={() => setReviewing(true)}>
            {t('pack.review')}
          </button>
        </div>
      </div>
      {found && <p className="mt-3 text-xs leading-5 text-pm-muted">{found.length > 0 ? t('pack.found', { names: found.join(', ') }) : t('pack.noneYet')}</p>}
      {cantSetUp.length > 0 && <p className="mt-1 text-xs leading-5 text-pm-muted">{t('pack.cantSetUp', { names: cantSetUp.join(', ') })}</p>}
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-pm-border bg-pm-bg px-3 py-2 text-xs leading-5 text-pm-text">
          {error}
        </p>
      )}
      {notice && <p className="mt-3 text-xs leading-5 text-pm-muted">{notice}</p>}
      {reviewing && (
        <PackSheet
          api={api}
          onChanged={() => void refresh()}
          onClose={() => setReviewing(false)}
          onDone={(text, done) => {
            setReviewing(false);
            setNotice(text);
            setRecorded(done.recorded);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
