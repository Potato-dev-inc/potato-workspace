// A compact model dropdown, used by the New agent page and by Settings > Agents > Helper agents. "Default" comes
// first (it names the default model when that is known). A long list gets a search box; with no list (loading failed,
// or the agent lists none) the same box takes a typed model id.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelListState } from '../../lib/modelOptions';
import '../../styles/model-picker.css';

export const LONG_LIST = 8;

/** What the closed picker says. */
export function pickerText(value: string, defaultWord: string, defaultModel: string | null): string {
  return value || (defaultModel ? `${defaultWord} (${defaultModel})` : defaultWord);
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
  const id = useId();
  const options = state.status === 'ready' ? state.options : null;
  const models = options?.models ?? [];
  const defaultModel = options?.defaultModel ?? null;
  const typed = state.status === 'failed' || (state.status === 'ready' && models.length === 0);
  const searchable = typed || models.length > LONG_LIST;
  const shown = useMemo(() => filterModels(models, query), [models, query]);
  const q = query.trim();
  const custom = q !== '' && !models.some((m) => m.toLowerCase() === q.toLowerCase());

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => {
    if (open && searchable) box.current?.focus();
    if (!open) setQuery('');
  }, [open, searchable]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const text = pickerText(value, defaultWord, defaultModel);
  return (
    <div className={`mp${className ? ` ${className}` : ''}`} ref={root}>
      <button type="button" className="mp-chip" data-testid={testId} aria-label={`${label}: ${text}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <span className="mp-chip-text">{text}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="mp-menu" id={id} role="listbox" aria-label={label}>
          {searchable && (
            <input
              ref={box}
              className="mp-search"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={typed ? 'Type a model id' : 'Search or type a model id'}
              aria-label={typed ? 'Type a model id' : 'Search models'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (q === '') return;
                const exact = models.find((m) => m.toLowerCase() === q.toLowerCase());
                choose(exact ?? shown[0] ?? q);
              }}
            />
          )}
          <button type="button" role="option" aria-selected={value === ''} className="mp-item" onClick={() => choose('')}>
            <span>{defaultWord}</span>
            {defaultModel && <span className="mp-item-hint">{defaultModel}</span>}
          </button>
          {state.status === 'loading' && <p className="mp-note">Loading models…</p>}
          {state.status === 'failed' && <p className="mp-note">Could not load the list.</p>}
          {shown.map((m) => (
            <button key={m} type="button" role="option" aria-selected={value === m} className="mp-item" onClick={() => choose(m)}>
              <span className="mp-item-id">{m}</span>
            </button>
          ))}
          {searchable && custom && shown.length === 0 && (
            <button type="button" role="option" aria-selected={false} className="mp-item" onClick={() => choose(q)}>
              <span className="mp-item-id">Use “{q}”</span>
            </button>
          )}
          {value !== '' && !models.includes(value) && (
            <button type="button" role="option" aria-selected className="mp-item" onClick={() => choose(value)}>
              <span className="mp-item-id">{value}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
