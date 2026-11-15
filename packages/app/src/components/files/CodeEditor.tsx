// A read-only code view: line numbers, colours for the language, text you can select and copy. CodeMirror 6, loaded
// only when a code file is opened (see FileTab). Colours come from the cockpit's tokens, so light and dark just work.
import { useEffect, useRef } from 'react';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { highlight, theme } from './editor-style';
import { languageFor } from './languages';

/** Lines the person has selected: 1-based, with the text. */
export interface CodeSelection {
  from: number;
  to: number;
  text: string;
}

/** A line to bring into view and mark (1-based). A new `nonce` asks again for the same line. */
export interface CodeGoTo {
  line: number;
  nonce: number;
}

const markLine = StateEffect.define<number>();
const lineMark = Decoration.line({ class: 'cm-hit-line' });
/** The one line that "Search inside files" opened the file at. */
const markedLine = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(markLine)) return Decoration.set([lineMark.range(e.value)]);
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function CodeEditor({ path, text, onSelect, goTo }: { path: string; text: string; onSelect?: (selection: CodeSelection | null) => void; goTo?: CodeGoTo }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
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
          markedLine,
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
    viewRef.current = view;
    let gone = false;
    languageFor(path)?.then(
      (ext) => {
        if (!gone) view.dispatch({ effects: language.reconfigure(ext) });
      },
      () => undefined,
    );
    return () => {
      gone = true;
      viewRef.current = null;
      view.destroy();
    };
  }, [path, text]);

  // Opened at a line (a hit of "Search inside files"): the line is marked and brought to the middle.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !goTo || goTo.line < 1) return;
    const row = view.state.doc.line(Math.min(goTo.line, view.state.doc.lines));
    view.dispatch({ selection: { anchor: row.from }, effects: [markLine.of(row.from), EditorView.scrollIntoView(row.from, { y: 'center' })] });
  }, [goTo, path, text]);

  return <div ref={host} className="ck-fcode" data-testid="file-code" />;
}
