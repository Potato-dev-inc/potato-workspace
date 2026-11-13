// A read-only code view: line numbers, colours for the language, text you can select and copy. CodeMirror 6, loaded
// only when a code file is opened (see FileTab). Colours come from the cockpit's tokens, so light and dark just work.
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as tg } from '@lezer/highlight';
import { languageFor } from './languages';

/** Lines the person has selected: 1-based, with the text. */
export interface CodeSelection {
  from: number;
  to: number;
  text: string;
}

const highlight = HighlightStyle.define([
  { tag: [tg.keyword, tg.controlKeyword, tg.moduleKeyword, tg.definitionKeyword], color: 'var(--accent)' },
  { tag: [tg.string, tg.regexp, tg.special(tg.string)], color: 'var(--label-2)' },
  { tag: [tg.number, tg.bool, tg.null, tg.atom], color: 'var(--accent)' },
  { tag: [tg.comment, tg.lineComment, tg.blockComment], color: 'var(--label-3)', fontStyle: 'italic' },
  { tag: [tg.typeName, tg.className, tg.namespace], color: 'var(--label)', fontWeight: '600' },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName)], color: 'var(--label)', fontWeight: '600' },
  { tag: [tg.heading, tg.strong], color: 'var(--label)', fontWeight: '600' },
  { tag: [tg.link, tg.url], color: 'var(--label-2)', textDecoration: 'underline' },
]);

const theme = EditorView.theme({
  '&': { color: 'var(--label)', backgroundColor: 'transparent', fontSize: '12px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--label)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--label-3)', border: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--fill-active)' },
  '.cm-line': { padding: '0 12px 0 4px' },
});

export function CodeEditor({ path, text, onSelect }: { path: string; text: string; onSelect?: (selection: CodeSelection | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          syntaxHighlighting(highlight),
          theme,
          language.of([]),
          EditorView.contentAttributes.of({ 'aria-readonly': 'true', 'aria-label': path }),
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet) return;
            const main = u.state.selection.main;
            if (main.empty) return selectRef.current?.(null);
            const doc = u.state.doc;
            selectRef.current?.({ from: doc.lineAt(main.from).number, to: doc.lineAt(main.to).number, text: doc.sliceString(main.from, main.to) });
          }),
        ],
      }),
    });
    let gone = false;
    languageFor(path)?.then(
      (ext) => {
        if (!gone) view.dispatch({ effects: language.reconfigure(ext) });
      },
      () => undefined,
    );
    return () => {
      gone = true;
      view.destroy();
    };
  }, [path, text]);

  return <div ref={host} className="ck-fcode" data-testid="file-code" />;
}
