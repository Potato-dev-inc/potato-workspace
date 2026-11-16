// The floating mark-up bar: Select, Pen, Shape (with a list), Text, Colour, Undo, Clear, Send to chat, Close. A small
// solid pill at the bottom-centre of the page area. On a narrow pane tools never disappear: Undo and Clear fold into a
// "more" menu first, then "Send to chat" becomes an icon. Select, Pen, Shape, Text and Close always show.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { MARKUP_SPEC, type MarkupState, type ShapeId, type ToolId } from '../../lib/markup/model';
import { Menu } from '../common/Floating';

const ICONS = MARKUP_SPEC.icons as Record<string, string>;

export function Icon({ name, box = '0 0 20 20' }: { name: string; box?: string }) {
  return (
    <svg viewBox={box} aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}

export interface BarActions {
  tool: (tool: ToolId) => void;
  shape: (shape: ShapeId) => void;
  color: (color: string) => void;
  popup: (popup: 'shapes' | 'colors' | 'more') => void;
  /** Close whichever popup is open (an outside press or Escape). Unlike `popup`, it never opens one. */
  closePopup: () => void;
  undo: () => void;
  clear: () => void;
  send: () => void;
  close: () => void;
}

const KEY_LABEL: Record<string, string> = { select: 'V', pen: 'P', text: 'T' };

export function MarkupBar({ state, width, actions, selectDisabled = false }: { state: MarkupState; width: number; actions: BarActions; selectDisabled?: boolean }) {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const n = state.marks.length;
  const foldUndo = width > 0 && width < MARKUP_SPEC.narrow.foldUndoClear;
  const iconSend = width > 0 && width < MARKUP_SPEC.narrow.sendAsIcon;
  const shapeWord = (s: ShapeId) => t(`markup.shape.${s}` as 'markup.shape.rect');
  const shapesBtn = useRef<HTMLButtonElement>(null);
  const colourBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);

  // Arrow keys move between the buttons (a toolbar).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const items = [...(bar.current?.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    items[(at + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const tool = (id: ToolId, icon: string, label: string, on: boolean, disabled = false, hint?: string) => (
    <button
      key={id}
      type="button"
      className="mk-tb"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      title={hint ? `${label} (${hint})` : label}
      data-testid={`markup-${id}`}
      onClick={() => actions.tool(id)}
    >
      <Icon name={icon} />
    </button>
  );
  const plain = (testid: string, icon: string, label: string, onClick: () => void, disabled = false, hint?: string) => (
    <button key={testid} type="button" className="mk-tb" aria-label={label} disabled={disabled} title={hint ? `${label} (${hint})` : label} data-testid={testid} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );

  let more: ReactNode = null;
  if (state.popup === 'shapes') {
    more = (
      <Menu anchorRef={shapesBtn} prefer="up" align="start" className="mk-pop mk-pop--col" label={t('markup.tool.moreShapes')} testId="markup-shapes-menu" onClose={actions.closePopup}>
        {MARKUP_SPEC.shapes.map((s) => (
          <button key={s.id} type="button" role="menuitem" data-testid={`markup-shape-${s.id}`} onClick={() => actions.shape(s.id as ShapeId)}>
            <Icon name={s.id} />
            {shapeWord(s.id as ShapeId)}
            <kbd>{s.key.toUpperCase()}</kbd>
          </button>
        ))}
      </Menu>
    );
  } else if (state.popup === 'colors') {
    more = (
      <Menu anchorRef={colourBtn} prefer="up" align="start" className="mk-pop" label={t('markup.tool.colour')} testId="markup-colors-menu" onClose={actions.closePopup}>
        {MARKUP_SPEC.colors.map((c) => (
          <button key={c.id} type="button" role="menuitem" className="mk-sw" aria-label={t(`markup.colour.${c.id}` as 'markup.colour.orange')} data-testid={`markup-colour-${c.id}`} onClick={() => actions.color(c.value)}>
            <span className="mk-dot" style={{ background: c.value }} />
          </button>
        ))}
      </Menu>
    );
  } else if (state.popup === 'more') {
    more = (
      <Menu anchorRef={moreBtn} prefer="up" align="end" className="mk-pop mk-pop--col" label={t('markup.tool.more')} testId="markup-more-menu" onClose={actions.closePopup}>
        <button type="button" role="menuitem" disabled={!n} data-testid="markup-undo" onClick={actions.undo}>
          <Icon name="undo" />
          {t('markup.tool.undo')}
          <kbd>Ctrl+Z</kbd>
        </button>
        <button type="button" role="menuitem" disabled={!n} data-testid="markup-clear" onClick={actions.clear}>
          <Icon name="clear" />
          {t('markup.tool.clear')}
        </button>
      </Menu>
    );
  }

  return (
    <div ref={bar} className="mk-bar" role="toolbar" aria-label={t('markup.bar')} onKeyDown={onKeyDown} data-testid="markup-bar" data-narrow={foldUndo ? (iconSend ? 'icon' : 'fold') : undefined}>
      {tool('select', 'select', t('markup.tool.select'), state.tool === 'select', selectDisabled, KEY_LABEL.select)}
      {tool('pen', 'pen', t('markup.tool.pen'), state.tool === 'pen', false, KEY_LABEL.pen)}
      {tool('shape', state.shape, t('markup.tool.shape'), state.tool === 'shape', false, 'R A O')}
      <button ref={shapesBtn} type="button" className="mk-tb mk-tb--caret" aria-label={t('markup.tool.moreShapes')} aria-haspopup="menu" aria-expanded={state.popup === 'shapes'} data-testid="markup-shapes" onClick={() => actions.popup('shapes')}>
        <Icon name="caret" box="0 0 9 9" />
      </button>
      {tool('text', 'text', t('markup.tool.text'), state.tool === 'text', false, KEY_LABEL.text)}
      <button ref={colourBtn} type="button" className="mk-tb" aria-label={t('markup.tool.colour')} aria-haspopup="menu" aria-expanded={state.popup === 'colors'} title={t('markup.tool.colour')} data-testid="markup-colour" onClick={() => actions.popup('colors')}>
        <span className="mk-dot" style={{ background: state.color }} />
      </button>
      <span className="mk-sep" aria-hidden="true" />
      {foldUndo ? (
        <button ref={moreBtn} type="button" className="mk-tb" aria-label={t('markup.tool.more')} aria-haspopup="menu" aria-expanded={state.popup === 'more'} title={t('markup.tool.more')} data-testid="markup-more" onClick={() => actions.popup('more')}>
          <Icon name="more" />
        </button>
      ) : (
        <>
          {plain('markup-undo', 'undo', t('markup.tool.undo'), actions.undo, !n, 'Ctrl+Z')}
          {plain('markup-clear', 'clear', t('markup.tool.clear'), actions.clear, !n)}
        </>
      )}
      <span className="mk-sep" aria-hidden="true" />
      <button
        type="button"
        className={`mk-send${iconSend ? ' mk-send--icon' : ''}`}
        disabled={!n}
        aria-label={t('markup.tool.send')}
        title={`${t('markup.tool.send')} (Ctrl+Enter)`}
        data-testid="markup-send"
        onClick={actions.send}
      >
        {iconSend ? <Icon name="send" /> : n ? t('markup.tool.sendCount', { n }) : t('markup.tool.send')}
      </button>
      {plain('markup-close', 'close', t('markup.tool.close'), actions.close, false, 'Esc')}
      {more}
    </div>
  );
}
