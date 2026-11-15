// The look of the code view and the code editor (one chunk with them): syntax colours and the editor chrome, all from
// the cockpit's tokens, so the light and the dark theme both just work. Quiet by default: the words that matter get
// a colour, the rest stays the normal text colour.
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as tg } from '@lezer/highlight';

export const highlight = HighlightStyle.define([
  { tag: [tg.keyword, tg.controlKeyword, tg.moduleKeyword, tg.definitionKeyword, tg.operatorKeyword], color: 'var(--accent)' },
  { tag: [tg.string, tg.regexp, tg.special(tg.string)], color: 'var(--live)' },
  { tag: [tg.number, tg.bool, tg.null, tg.atom], color: 'var(--icon-blue)' },
  { tag: [tg.comment, tg.lineComment, tg.blockComment], color: 'var(--label-3)', fontStyle: 'italic' },
  { tag: [tg.typeName, tg.className, tg.namespace], color: 'var(--risk)', fontWeight: '600' },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: 'var(--label)', fontWeight: '600' },
  { tag: [tg.propertyName, tg.attributeName], color: 'var(--label-2)' },
  { tag: [tg.tagName], color: 'var(--accent)' },
  { tag: [tg.heading, tg.strong], color: 'var(--label)', fontWeight: '600' },
  { tag: [tg.emphasis], fontStyle: 'italic' },
  { tag: [tg.link, tg.url], color: 'var(--icon-blue)', textDecoration: 'underline' },
  { tag: [tg.invalid], color: 'var(--danger)' },
]);

export const theme = EditorView.theme({
  '&': { color: 'var(--label)', backgroundColor: 'transparent', fontSize: '12px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--label)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--label)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--label-3)', border: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--fill-active)' },
  '.cm-line': { padding: '0 12px 0 4px' },
});

/** What only the editor needs: the current line, and the find box (Ctrl+F) in the same quiet style. */
export const editTheme = EditorView.theme({
  '.cm-activeLine': { backgroundColor: 'var(--fill)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--label)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)', outline: '2px solid var(--accent)' },
  '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--label)', fontFamily: 'var(--font-ui)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--sep)' },
  '.cm-panel.cm-search': { padding: '6px 28px 6px 10px', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { fontSize: '12px' },
  '.cm-panel.cm-search input.cm-textfield': {
    color: 'var(--label)',
    backgroundColor: 'var(--fill)',
    border: '1px solid var(--sep)',
    borderRadius: '5px',
    padding: '2px 6px',
  },
  '.cm-panel.cm-search input.cm-textfield:focus': { outline: 'none', boxShadow: 'var(--focus)' },
  '.cm-panel.cm-search button': {
    color: 'var(--label)',
    backgroundColor: 'var(--fill)',
    backgroundImage: 'none',
    border: '1px solid var(--sep)',
    borderRadius: '5px',
    padding: '2px 8px',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search button:hover': { backgroundColor: 'var(--fill-hover)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--label-2)', border: 'none', backgroundColor: 'transparent' },
});
