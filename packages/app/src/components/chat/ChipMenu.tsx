// The small controls on the footer line of the message box: a pop-up menu (one pick from a list) and a compact
// segmented switch (a few short choices side by side). Both are keyboard friendly: arrows move, Enter picks, Esc
// closes and gives the focus back. Generic: they know nothing about which setting they show.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import '../../styles/chat-input-card.css';

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
}

function Chevron() {
  return (
    <svg className="ck-pill-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
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
export function ChipMenu({ chipId, label, value, choices, disabled = false, onChange }: ControlProps & { chipId: string }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = Math.max(0, choices.findIndex((c) => c.value === value));
  const current = choices.find((c) => c.value === value)?.name ?? value;

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };
  const openList = () => {
    if (disabled) return;
    setActive(selected);
    setOpen(true);
  };
  // The list takes the focus while it is open, so the arrows work at once.
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);
  // A click outside closes it (the focus stays where the person clicked).
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
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
  return (
    <div ref={root} className="ck-menu-rel" data-chip-id={chipId} data-chip-kind="menu" data-value={value} data-disabled={disabled || undefined}>
      <button
        ref={button}
        type="button"
        className="ck-pill"
        aria-label={label}
        title={label}
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
        <span className="ck-pill-label">{current}</span>
        <Chevron />
      </button>
      {open && (
        <div ref={list} id={listId} className="ck-pop" role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${uid}-opt-${active}`} onKeyDown={onListKey}>
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
        </div>
      )}
    </div>
  );
}

/** A few short choices side by side; the picked one sits on a sliding thumb. One tab stop, arrows move the pick. */
export function ChipSegmented({ chipId, label, value, choices, disabled = false, onChange }: ControlProps & { chipId: string }) {
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
