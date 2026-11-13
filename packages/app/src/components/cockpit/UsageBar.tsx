// The "Used" bar along the bottom edge of the cockpit window: one chip per signed-in agent (and per account) with the
// fullest limit window's percent used and the time until it resets, or Limit reached / Sign-in expired / Usage not shared.
// A chip warns at 80 % used. Clicking the strip opens the Usage popover: every sign-in, tightest limit first,
// a bar per window with its reset time, the agent's own usage page, and Refresh.
// Off with Settings > General > "Show usage bar". Nothing shows until there is a signed-in agent.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  chipText,
  formatCost,
  formatLeftLong,
  formatTokens,
  rowName,
  tightestFirst,
  tooltip,
  useUsage,
  useUsageBarOn,
  usageApi,
  warns,
  type UsageApi,
  type UsageRow,
} from '../../lib/usage';
import { AgentLogo } from '../common/AgentLogo';
import '../../styles/usage-strip.css';
import '../../styles/cockpit-statusbar.css';

function RefreshIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </svg>
  );
}

/** The agent's mark: its logo in brand colour, or the monogram (first letter of its name) when it has none. */
export function AgentMark({ row }: { row: UsageRow }) {
  return (
    <span className="ck-usage-ic is-logo" aria-hidden="true">
      <AgentLogo id={row.agent_id} name={row.label} size={12} decorative />
    </span>
  );
}

/** A tiny tag that tells several sign-ins of one agent apart: the account label's first two letters. */
export function signInSuffix(row: UsageRow, agentHasSeveral: boolean): string | null {
  if (!agentHasSeveral || !row.account_label) return null;
  // The whole short name ("Work"), never a clipped piece of it. Long names end in "…"; the tooltip has the full one.
  const label = row.account_label.trim();
  return label.length > 12 ? `${label.slice(0, 11)}…` : label;
}

function Chip({
  row,
  now,
  onOpen,
  suffix,
}: {
  row: UsageRow;
  now: number;
  onOpen: (e: { currentTarget: HTMLElement }) => void;
  suffix: string | null;
}) {
  const warn = warns(row);
  const tip = tooltip(row, now).replace('Click to open its usage page', 'Click for details');
  return (
    <button
      type="button"
      className={`ck-usage-chip is-${row.state}${warn ? ' is-warn' : ''}`}
      title={tip}
      aria-label={tip.replace(/\n/g, '. ')}
      aria-haspopup="dialog"
      onClick={onOpen}
      data-agent={row.agent_id}
    >
      <AgentMark row={row} />
      {suffix && (
        <span className="ck-usage-suffix" aria-hidden="true">
          {suffix}
        </span>
      )}
      <span className="ck-usage-text" aria-hidden="true">
        {warn && <span className="ck-usage-warn">⚠ </span>}
        {chipText(row, now)}
      </span>
    </button>
  );
}

function PopRow({ row, now, api }: { row: UsageRow; now: number; api: UsageApi }) {
  return (
    <li className={`ck-usage-pop-row is-${row.state}`} data-agent={row.agent_id}>
      <div className="ck-usage-pop-head">
        <AgentMark row={row} />
        <span className="ck-usage-pop-name">{rowName(row)}</span>
        {row.plan && <span className="ck-usage-pop-plan">{row.plan}</span>}
        <span className="ck-usage-pop-state">{warns(row) ? `⚠ ${chipText(row, now)}` : row.state === 'unknown' ? 'Usage not shared by this agent' : ''}</span>
      </div>
      {row.windows.map((w) => {
        const pct = Math.max(0, Math.min(100, Math.round(w.used_percent)));
        const reset = w.reset_since ? 'Started again' : w.resets_at_ms ? `Resets in ${formatLeftLong(w.resets_at_ms - now)}` : '';
        return (
          <div key={w.name} className="ck-usage-win">
            <span className="ck-usage-win-name">{w.name}</span>
            <span
              className={`ck-usage-bar${pct >= 80 ? ' is-high' : ''}`}
              role="meter"
              aria-label={`${w.name} used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="ck-usage-win-pct">{pct}% used</span>
            <span className="ck-usage-win-reset">{reset}</span>
          </div>
        );
      })}
      {row.totals && (
        <div className="ck-usage-totals" data-testid="usage-totals">
          <div className="ck-usage-win">
            <span className="ck-usage-win-name">Today</span>
            <span className="ck-usage-win-pct">
              {formatCost(row.totals.today.cost)} · {formatTokens(row.totals.today.tokens)} tokens
            </span>
          </div>
          <div className="ck-usage-win">
            <span className="ck-usage-win-name">Last 7 days</span>
            <span className="ck-usage-win-pct">
              {formatCost(row.totals.week.cost)} · {formatTokens(row.totals.week.tokens)} tokens
            </span>
          </div>
          {row.totals.models.slice(0, 5).map((m) => (
            <div key={m.model} className="ck-usage-win ck-usage-model">
              <span className="ck-usage-win-name">{m.model}</span>
              <span className="ck-usage-win-pct">
                {formatCost(m.cost)} · {formatTokens(m.tokens)} tokens
              </span>
            </div>
          ))}
        </div>
      )}
      {row.reason && <p className="ck-usage-pop-reason">{row.reason}</p>}
      <div className="ck-usage-pop-foot">
        <span>{row.observed_at_ms ? `Read ${formatLeftLong(now - row.observed_at_ms)} ago` : ''}</span>
        {row.page && (
          <button type="button" className="ck-usage-link" onClick={() => void api.openPage(row.page as string).catch(() => {})}>
            Usage page
          </button>
        )}
      </div>
    </li>
  );
}

/** Where the popover goes: above the strip, 360px wide (less in a narrow window), never past an edge. */
export function popoverPlace(anchor: { left: number; top: number }, winW: number, winH: number) {
  const margin = 8;
  const width = Math.max(240, Math.min(360, winW - margin * 2));
  const left = Math.max(margin, Math.min(anchor.left, winW - width - margin));
  const bottom = Math.max(margin, winH - anchor.top + 6);
  return { left, bottom, width };
}

/** How many chips fit in `available` px, keeping room for a "+N" chip when not all fit. Pure, for the tests. */
export function fitCount(widths: number[], available: number, gap: number, plusWidth: number): number {
  const total = widths.reduce((sum, w, i) => sum + w + (i > 0 ? gap : 0), 0);
  if (total <= available) return widths.length;
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + (i > 0 ? gap : 0) + widths[i];
    if (next + gap + plusWidth > available) return i;
    used = next;
  }
  return widths.length;
}

const GAP = 10;
const PLUS_WIDTH = 34;

/**
 * The bottom status bar of the cockpit: "Used", one chip per sign-in, refresh at the right end. One line: chips
 * that do not fit become "+N". Clicking a chip or "+N" opens the Usage popover above the bar. The cockpit root
 * leaves room for it only while it is shown (cockpit-statusbar.css, `:has`).
 */
export function UsageBar({ api = usageApi }: { api?: UsageApi }) {
  const { on, loginReads } = useUsageBarOn();
  const { snap, busy, refresh } = useUsage(api, on === true, loginReads);
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const measureRow = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const rows = Array.isArray(snap?.rows) ? snap.rows : [];
  const open = anchor !== null;

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Fit the chips on one line: measure each chip in a hidden copy, then show as many as fit.
  useLayoutEffect(() => {
    const fit = () => {
      const avail = row.current?.clientWidth ?? 0;
      const widths = [...(measureRow.current?.children ?? [])].map((c) => (c as HTMLElement).offsetWidth);
      setShown(avail > 0 ? fitCount(widths, avail, GAP, PLUS_WIDTH) : null);
    };
    fit();
    if (typeof ResizeObserver === 'undefined' || !row.current) return;
    const ro = new ResizeObserver(fit);
    ro.observe(row.current);
    return () => ro.disconnect();
  }, [rows.length, snap, now]);

  useLayoutEffect(() => {
    if (!anchor) return;
    const measure = () => {
      const top = bar.current?.getBoundingClientRect().top ?? window.innerHeight;
      setPlace(popoverPlace({ left: anchor.left, top }, window.innerWidth, window.innerHeight));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!bar.current?.contains(t) && !pop.current?.contains(t)) setAnchor(null);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setAnchor(null);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  // Off, or no signed-in agent, or a malformed answer (an older desktop): no bar and no space.
  if (on !== true || rows.length === 0) return null;
  const toggle = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor((a) => (a ? null : { left: r.left, top: r.top }));
  };
  const refreshBtn = (
    <button
      type="button"
      className={`ck-usage-refresh${busy ? ' is-busy' : ''}`}
      aria-label="Refresh usage"
      title="Refresh usage"
      onClick={() => void refresh()}
      disabled={busy}
    >
      <RefreshIcon />
    </button>
  );
  const count = shown ?? rows.length;
  const hidden = rows.length - count;
  const key = (r: UsageRow) => `${r.agent_id}:${r.account_id ?? ''}`;
  const perAgent = new Map<string, number>();
  for (const r of rows) perAgent.set(r.agent_id, (perAgent.get(r.agent_id) ?? 0) + 1);
  const suffixOf = (r: UsageRow) => signInSuffix(r, (perAgent.get(r.agent_id) ?? 0) > 1);
  return (
    <div className="ck-statusbar" ref={bar} role="group" aria-label="Plan usage">
      <span className="ck-usage-cap">Usage</span>
      <div className="ck-sb-chips" ref={row}>
        {rows.slice(0, count).map((r) => (
          <Chip key={key(r)} row={r} now={now} onOpen={toggle} suffix={suffixOf(r)} />
        ))}
        {hidden > 0 && (
          <button
            type="button"
            className="ck-sb-more"
            aria-label={`${hidden} more: open usage`}
            title={rows.slice(count).map(rowName).join(', ')}
            aria-haspopup="dialog"
            onClick={toggle}
          >
            +{hidden}
          </button>
        )}
      </div>
      {/* The same chips, unseen, so their natural widths can be measured. */}
      <div className="ck-sb-measure" ref={measureRow} aria-hidden="true">
        {rows.map((r) => (
          <Chip key={key(r)} row={r} now={now} onOpen={() => {}} suffix={suffixOf(r)} />
        ))}
      </div>
      {refreshBtn}
      {open &&
        createPortal(
          <div
            ref={pop}
            className="ck-usage-pop"
            role="dialog"
            aria-label="Usage"
            style={place ? { left: place.left, bottom: place.bottom, width: place.width } : { visibility: 'hidden' }}
          >
            <div className="ck-usage-pop-top">
              <span className="ck-usage-pop-title">Usage</span>
              {refreshBtn}
            </div>
            <ul className="ck-usage-pop-list">
              {tightestFirst(rows).map((r) => (
                <PopRow key={key(r)} row={r} now={now} api={api} />
              ))}
            </ul>
          </div>,
          document.querySelector('.cockpit') ?? document.body,
        )}
    </div>
  );
}
