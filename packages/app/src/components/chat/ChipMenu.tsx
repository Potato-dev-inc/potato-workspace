// The small controls on the footer line of the message box: a pop-up menu (one pick from a list) and a compact
// segmented switch (a few short choices side by side). Both are keyboard friendly: arrows move, Enter picks, Esc
// closes and gives the focus back. Generic: they know nothing about which setting they show.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import '../../styles/chat-input-card.css';
import { useDismissable } from '../../hooks/useDismissable';
import { useT } from '../../i18n';
import { providerOf } from '../common/ModelPicker';

export interface ChipChoice {
  value: string;
  name: string;
  description?: string | null;
}

interface ControlProps {
  /** The plain name of the setting ("Model"), read out by screen readers. */
  label: string;
  value: string;
  choices: readonly ChipChoice[];
  disabled?: boolean;
  onChange: (value: string) => void;
  /** `risk`: the pill is drawn in the warning colour with a shield (the permission chip in Full access). */
  tone?: 'risk';
  /** Shown as plain text: no list, no chevron (the permission chip of an agent that runs in a terminal). */
  readOnly?: boolean;
  /** What the chip sets, said in words (the hover text). Falls back to `label`. */
  hint?: string;
  /** A small dim word before the value, for a setting whose value alone says little ("Default"). */
  caption?: string;
  /** A search box at the top of the list (the model chip: the agent can offer dozens of models). */
  searchable?: boolean;
}

/** The choices a search keeps: every word typed must appear in the name, id, note or maker, in any case. */
export function filterChoices(choices: readonly ChipChoice[], query: string): ChipChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...choices];
  return choices.filter((c) => {
    const hay = `${c.name} ${c.value} ${c.description ?? ''} ${providerOf(c) ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function Chevron() {
  return (
    <svg className="ck-pill-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function Shield() {
  return (
    <svg className="ck-pill-shield" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.8l5 1.8v4c0 3-2.1 5-5 6.6C5.1 12.6 3 10.6 3 7.6v-4z" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** A pill that opens a list above it. The pill shows the name of the current choice. */
export function ChipMenu({ chipId, label, value, choices: allChoices, disabled = false, onChange, tone, readOnly = false, hint, caption, searchable = false }: ControlProps & { chipId: string }) {
  const t = useT();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const choices = searchable ? filterChoices(allChoices, query) : allChoices;
  const current = allChoices.find((c) => c.value === value)?.name ?? value;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };
  const openList = () => {
    if (disabled) return;
    setQuery('');
    setActive(Math.max(0, allChoices.findIndex((c) => c.value === value)));
    setOpen(true);
  };
  // Keep the list inside the window: slide it left when it runs past the right edge, drop it below the pill when there is no room above.
  useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    el.style.left = '';
    el.style.bottom = '';
    el.style.top = '';
    const r = el.getBoundingClientRect();
    const view = document.documentElement.clientWidth;
    if (r.right > view - 8) el.style.left = `${Math.min(0, view - 8 - r.right)}px`;
    if (r.left < 8 && r.right <= view - 8) el.style.left = `${8 - r.left}px`;
    if (r.top < 8) {
      el.style.bottom = 'auto';
      el.style.top = 'calc(100% + 8px)';
    }
  }, [open, choices.length]);
  // The list takes the focus while it is open, so the arrows work at once.
  useEffect(() => {
    if (open) (searchable ? box.current : list.current)?.focus();
  }, [open]);
  // A click outside closes it (the focus stays where the person clicked). Escape is handled in onListKey (it keeps the composer's Esc away).
  useDismissable(open, { inside: [root], anchor: root, ignore: ['escape'], onDismiss: () => setOpen(false) });
  // The pill goes off while the agent works: a list that is open closes.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const pick = (index: number) => {
    const choice = choices[index];
    close(true);
    if (choice && choice.value !== value) onChange(choice.value);
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // In the search box Space, Home and End belong to the typing.
    if (searchable && (event.key === ' ' || event.key === 'Home' || event.key === 'End')) return;
    if (choices.length === 0 && event.key !== 'Escape' && event.key !== 'Tab') {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((active + 1) % choices.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((active - 1 + choices.length) % choices.length);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(choices.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        pick(active);
        break;
      case 'Escape':
        // The composer's own Esc (stop the agent) must not hear this one.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  const listId = `${uid}-list`;
  if (readOnly) {
    return (
      <div className="ck-menu-rel" data-chip-id={chipId} data-chip-kind="readonly" data-value={value} data-tone={tone}>
        <span className="ck-pill ck-pill--readonly" role="status" aria-label={`${label}: ${current}`} title={hint ?? label}>
          {tone === 'risk' && <Shield />}
          {caption && <span className="ck-pill-caption">{caption}</span>}
          <span className="ck-pill-label">{current}</span>
        </span>
      </div>
    );
  }
  return (
    <div ref={root} className="ck-menu-rel" data-chip-id={chipId} data-chip-kind="menu" data-value={value} data-tone={tone} data-disabled={disabled || undefined}>
      <button
        ref={button}
        type="button"
        className="ck-pill"
        aria-label={label}
        title={hint ?? label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            openList();
          }
        }}
      >
        {tone === 'risk' && <Shield />}
        {caption && <span className="ck-pill-caption">{caption}</span>}
        <span className="ck-pill-label">{current}</span>
        <Chevron />
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          className={searchable ? 'ck-pop ck-pop--search' : 'ck-pop'}
          role={searchable ? undefined : 'listbox'}
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={searchable ? undefined : `${uid}-opt-${active}`}
          onKeyDown={onListKey}
        >
          {searchable && (
            <input
              ref={box}
              className="ck-pop-search"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={t('state.model.search')}
              aria-label={t('state.model.search')}
              aria-controls={`${uid}-opts`}
              aria-activedescendant={choices.length ? `${uid}-opt-${active}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
          )}
          <div id={`${uid}-opts`} className={searchable ? 'ck-pop-list' : undefined} role={searchable ? 'listbox' : undefined} aria-label={searchable ? label : undefined}>
            {choices.map((choice, i) => (
              <div
                key={choice.value}
                id={`${uid}-opt-${i}`}
                role="option"
                aria-selected={choice.value === value}
                className={i === active ? 'ck-opt ck-opt--active' : 'ck-opt'}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <span className="ck-opt-text">
                  {choice.name}
                  {choice.description && <small>{choice.description}</small>}
                </span>
                <span className="ck-opt-check">
                  <Check />
                </span>
              </div>
            ))}
            {choices.length === 0 && <p className="ck-pop-empty">{t('pane.noModelsMatch')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A few short choices side by side; the picked one sits on a sliding thumb. One tab stop, arrows move the pick. */
export function ChipSegmented({ chipId, label, value, choices, disabled = false, onChange, hint }: ControlProps & { chipId: string }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, choices.findIndex((c) => c.value === value));
  const move = (to: number) => {
    const next = (to + choices.length) % choices.length;
    buttons.current[next]?.focus();
    if (choices[next].value !== value) onChange(choices[next].value);
  };
  return (
    <div
      className="ck-seg"
      role="radiogroup"
      aria-label={label}
      title={hint}
      data-chip-id={chipId}
      data-chip-kind="segmented"
      data-value={value}
      data-disabled={disabled || undefined}
      style={{ ['--n' as string]: choices.length, ['--i' as string]: index }}
    >
      <span className="ck-seg-thumb" aria-hidden="true" />
      {choices.map((choice, i) => (
        <button
          key={choice.value}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          className="ck-seg-btn"
          aria-checked={i === index}
          tabIndex={i === index ? 0 : -1}
          title={choice.description ?? undefined}
          disabled={disabled}
          onClick={() => choice.value !== value && onChange(choice.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault();
              move(index + 1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault();
              move(index - 1);
            }
          }}
        >
          {choice.name}
        </button>
      ))}
    </div>
  );
}
