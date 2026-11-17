// A compact model dropdown, used by the New agent page and by Settings > Agents > Helper agents. "Default" comes
// first (it names the default model when that is known). A long list gets a search box; with no list (loading failed,
// or the agent lists none) the same box takes a typed model id.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { ModelListState } from '../../lib/modelOptions';
import '../../styles/model-picker.css';
import { Popover } from './Floating';

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

/** Who makes a model, read from its id or name ("claude-opus", "Gemini 3.8 Flash", "openai/gpt-5"): the heading it sits under. */
export function providerOf(model: { value: string; name?: string }): string | null {
  const id = model.value.toLowerCase();
  const hay = `${id} ${(model.name ?? '').toLowerCase()}`;
  const slash = id.indexOf('/');
  if (slash > 0) {
    const maker = id.slice(0, slash);
    return maker === 'openai' ? 'OpenAI' : modelName(maker);
  }
  if (/\b(claude|opus|sonnet|haiku|anthropic)\b/.test(hay)) return 'Claude';
  if (/\b(gemini|gemma)\b/.test(hay)) return 'Gemini';
  if (/\b(gpt|codex|openai)\b|(^|[\s-])o[134]\b/.test(hay)) return 'OpenAI';
  if (/\b(llama|mistral|qwen|deepseek|grok|kimi)\b/.test(hay)) return modelName(/\b(llama|mistral|qwen|deepseek|grok|kimi)\b/.exec(hay)![1]!);
  return null;
}

export interface ModelGroup<T> {
  /** The heading, or null for the single list of a short or one-maker list. */
  heading: string | null;
  items: T[];
}

/**
 * Puts the rows under their maker (first seen first, models of an unknown maker last under "Other"). A list that has only
 * one maker, or too few rows to need headings, stays one list with no heading.
 */
export function groupModels<T>(items: readonly T[], makerOf: (item: T) => string | null, other: string): ModelGroup<T>[] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const maker = makerOf(item) ?? other;
    if (!buckets.has(maker)) {
      buckets.set(maker, []);
      order.push(maker);
    }
    buckets.get(maker)!.push(item);
  }
  if (order.length < 2 || items.length < 4) return items.length ? [{ heading: null, items: [...items] }] : [];
  const named = order.filter((m) => m !== other);
  return [...named, ...order.filter((m) => m === other)].map((heading) => ({ heading, items: buckets.get(heading)! }));
}

function Tick() {
  return (
    <svg className="mp-tick" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
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

export function ModelPicker({ state, value, onChange, defaultWord: defaultWordProp, label, className, testId }: ModelPickerProps) {
  const t = useT();
  const defaultWord = defaultWordProp ?? t('state.model.default');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const chipEl = useRef<HTMLButtonElement>(null);
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
      {open && (
        // The shared floating layer: top layer, anchored to the chip, and it counts as inside any card the picker sits in.
        <Popover id={id} anchorRef={chipEl} align="start" role="listbox" className="mp-menu" label={label} minWidth={Math.max(260, Math.round(chipEl.current?.offsetWidth ?? 0))} maxHeight={MENU_MAX} onClose={() => setOpen(false)}>
          {searchable && (
            <input
              ref={box}
              className="mp-search"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={models.length === 0 ? t('state.model.typeId') : t('state.model.searchOrType')}
              aria-label={models.length === 0 ? t('state.model.typeId') : t('state.model.search')}
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
            {(value === '' || (liveDefault !== null && value === 'default')) && <Tick />}
          </button>
          {groupModels(liveRows, providerOf, t('state.model.other')).map((g) => (
            <div key={g.heading ?? ''} role="group" aria-label={g.heading ?? undefined} className="mp-group">
              {g.heading && (
                <div className="mp-group-h" aria-hidden="true">
                  {g.heading}
                </div>
              )}
              {g.items.map((m) => (
                <button key={m.value} type="button" role="option" aria-selected={value === m.value} className="mp-item mp-item-live" onClick={() => choose(m.value)}>
                  <span className="mp-item-id">{m.name}</span>
                  {m.description && <span className="mp-item-hint">{m.description}</span>}
                  {value === m.value && <Tick />}
                </button>
              ))}
            </div>
          ))}
          {state.status === 'loading' && <p className="mp-note">{t('state.model.loading')}</p>}
          {state.status === 'failed' && <p className="mp-note">{t('state.model.failed')}</p>}
          {state.status === 'ready' && options?.liveFailed && <p className="mp-note">{t('state.model.liveFailed')}</p>}
          {state.status === 'ready' && !options?.liveFailed && models.length === 0 && <p className="mp-note">{t('state.model.noList')}</p>}
          {groupModels(shown, (m) => providerOf({ value: m }), t('state.model.other')).map((g) => (
            <div key={g.heading ?? ''} role="group" aria-label={g.heading ?? undefined} className="mp-group">
              {g.heading && (
                <div className="mp-group-h" aria-hidden="true">
                  {g.heading}
                </div>
              )}
              {g.items.map((m) => (
                <button key={m} type="button" role="option" aria-selected={value === m} className="mp-item" onClick={() => choose(m)}>
                  <span className="mp-item-id">{modelName(m)}</span>
                  {value === m && <Tick />}
                </button>
              ))}
            </div>
          ))}
          {custom && (
            <button type="button" role="option" aria-selected={false} className="mp-item" onClick={() => choose(q)}>
              <span className="mp-item-id">{t('state.model.use', { q })}</span>
            </button>
          )}
          {value !== '' && value !== 'default' && !models.includes(value) && (
            <button type="button" role="option" aria-selected className="mp-item" onClick={() => choose(value)}>
              <span className="mp-item-id">{modelName(value)}</span>
              <Tick />
            </button>
          )}
        </Popover>
      )}
    </div>
  );
}
