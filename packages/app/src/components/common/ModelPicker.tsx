// A compact model dropdown, used by the New agent page and by Settings > Agents > Helper agents. "Default" comes
// first (it names the default model when that is known). A long list gets a search box; with no list (loading failed,
// or the agent lists none) the same box takes a typed model id.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelListState } from '../../lib/modelOptions';
import '../../styles/model-picker.css';

export const LONG_LIST = 8;

const MENU_MAX = 320;
const MENU_GAP = 6;
const EDGE = 8;

interface Place {
  left: number;
  top?: number;
  bottom?: number;
  /** The chip's top edge, for a menu above it (it is then placed by its measured height). */
  anchor?: number;
  maxHeight: number;
  minWidth: number;
}

/** Where the menu floats: under the chip, or above it when there is more room there. Fixed, so no card can clip it. */
export function placeMenu(chip: { left: number; top: number; bottom: number; width: number }, view: { width: number; height: number }, menuWidth = 340): Place {
  const below = view.height - chip.bottom - MENU_GAP - EDGE;
  const above = chip.top - MENU_GAP - EDGE;
  const up = below < Math.min(MENU_MAX, 200) && above > below;
  const maxHeight = Math.max(120, Math.min(MENU_MAX, up ? above : below));
  const left = Math.max(EDGE, Math.min(chip.left, view.width - menuWidth - EDGE));
  const minWidth = Math.max(260, Math.round(chip.width));
  return up ? { left, bottom: view.height - chip.top + MENU_GAP, anchor: chip.top - MENU_GAP, maxHeight, minWidth } : { left, top: chip.bottom + MENU_GAP, maxHeight, minWidth };
}

/** A model id as shown: capital first letter. The value itself is never changed. */
export function modelName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** What the closed picker says. */
export function pickerText(value: string, defaultWord: string, defaultModel: string | null): string {
  return value ? modelName(value) : defaultModel ? `${defaultWord} (${modelName(defaultModel)})` : defaultWord;
}

/** A live model a search keeps: every word typed must appear in its name, id or description, any case. */
export function liveMatches(m: { value: string; name: string; description: string | null }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${m.name} ${m.value} ${m.description ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The models a search keeps: every word typed must appear in the id, any case. */
export function filterModels(models: readonly string[], query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length === 0 ? [...models] : models.filter((m) => words.every((w) => m.toLowerCase().includes(w)));
}

export interface ModelPickerProps {
  state: ModelListState;
  /** The chosen model id; '' is the default. */
  value: string;
  onChange: (value: string) => void;
  /** Words for the default row: "Default" on the New agent page, "Agent's default" in Settings. */
  defaultWord?: string;
  /** Names the control for screen readers, e.g. "Model for Claude". */
  label: string;
  className?: string;
  testId?: string;
}

export function ModelPicker({ state, value, onChange, defaultWord = 'Default', label, className, testId }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const chipEl = useRef<HTMLButtonElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const id = useId();
  const options = state.status === 'ready' ? state.options : null;
  const models = options?.models ?? [];
  const defaultModel = options?.defaultModel ?? null;
  // Every agent takes a typed model id, so the box is always there.
  const searchable = true;
  const live = options?.live ?? null;
  // The agent's own "default" row (value `default`) is the blank choice: it is not listed twice.
  const liveDefault = live?.find((m) => m.value === 'default') ?? null;
  const liveRows = useMemo(() => (live ?? []).filter((m) => m.value !== 'default' && liveMatches(m, query)), [live, query]);
  const shown = useMemo(() => (live ? [] : filterModels(models, query)), [live, models, query]);
  const q = query.trim();
  const custom = q !== '' && !models.some((m) => m.toLowerCase() === q.toLowerCase()) && !(live ?? []).some((m) => m.name.toLowerCase() === q.toLowerCase());

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !menuEl.current?.contains(t)) setOpen(false);
    };
    const moved = (e: Event) => {
      if (!menuEl.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !chipEl.current) {
      setPlace(null);
      return;
    }
    const r = chipEl.current.getBoundingClientRect();
    setPlace(placeMenu(r, { width: window.innerWidth, height: window.innerHeight }));
  }, [open]);

  // A menu above the chip hangs from its own top edge (not from the window bottom), so it stays put if the window grows.
  useLayoutEffect(() => {
    const el = menuEl.current;
    if (!open || !place || place.anchor === undefined || !el) return;
    const top = Math.max(EDGE, place.anchor - el.offsetHeight);
    if (place.top !== top) setPlace({ ...place, top, bottom: undefined });
  }, [open, place, shown.length, state.status]);

  useEffect(() => {
    if (open && searchable) box.current?.focus();
    if (!open) setQuery('');
  }, [open, searchable]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const liveName = live ? (value ? live.find((m) => m.value === value)?.name : liveDefault?.name) : undefined;
  const text = liveName ?? pickerText(value, defaultWord, defaultModel);
  return (
    <div className={`mp${className ? ` ${className}` : ''}`} ref={root}>
      <button ref={chipEl} type="button" className="mp-chip" data-testid={testId} aria-label={`${label}: ${text}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <span className="mp-chip-text">{text}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && createPortal(
        <div ref={menuEl} className="mp-menu" id={id} role="listbox" aria-label={label} style={place ? { left: place.left, top: place.top, bottom: place.top === undefined ? place.bottom : undefined, maxHeight: place.maxHeight, minWidth: place.minWidth, position: 'fixed' } : { visibility: 'hidden', position: 'fixed' }}>
          {searchable && (
            <input
              ref={box}
              className="mp-search"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={models.length === 0 ? 'Type a model id' : 'Search or type a model id'}
              aria-label={models.length === 0 ? 'Type a model id' : 'Search models'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (q === '') return;
                const exact = models.find((m) => m.toLowerCase() === q.toLowerCase()) ?? live?.find((m) => m.name.toLowerCase() === q.toLowerCase())?.value;
                choose(exact ?? liveRows[0]?.value ?? shown[0] ?? q);
              }}
            />
          )}
          <button type="button" role="option" aria-selected={value === '' || (liveDefault !== null && value === 'default')} className={`mp-item${liveDefault ? ' mp-item-live' : ''}`} onClick={() => choose('')}>
            <span>{liveDefault ? liveDefault.name : defaultWord}</span>
            {liveDefault ? liveDefault.description && <span className="mp-item-hint">{liveDefault.description}</span> : defaultModel && <span className="mp-item-hint">{modelName(defaultModel)}</span>}
          </button>
          {liveRows.map((m) => (
            <button key={m.value} type="button" role="option" aria-selected={value === m.value} className="mp-item mp-item-live" onClick={() => choose(m.value)}>
              <span className="mp-item-id">{m.name}</span>
              {m.description && <span className="mp-item-hint">{m.description}</span>}
            </button>
          ))}
          {state.status === 'loading' && <p className="mp-note">Loading models… you can type a model id.</p>}
          {state.status === 'failed' && <p className="mp-note">Could not load the list. Type a model id.</p>}
          {state.status === 'ready' && models.length === 0 && <p className="mp-note">No list for this agent. Type a model id.</p>}
          {shown.map((m) => (
            <button key={m} type="button" role="option" aria-selected={value === m} className="mp-item" onClick={() => choose(m)}>
              <span className="mp-item-id">{modelName(m)}</span>
            </button>
          ))}
          {custom && (
            <button type="button" role="option" aria-selected={false} className="mp-item" onClick={() => choose(q)}>
              <span className="mp-item-id">Use “{q}”</span>
            </button>
          )}
          {value !== '' && value !== 'default' && !models.includes(value) && (
            <button type="button" role="option" aria-selected className="mp-item" onClick={() => choose(value)}>
              <span className="mp-item-id">{modelName(value)}</span>
            </button>
          )}
        </div>,
        document.querySelector('.cockpit') ?? document.body,
      )}
    </div>
  );
}
