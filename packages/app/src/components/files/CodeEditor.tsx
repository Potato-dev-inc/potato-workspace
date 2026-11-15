// A read-only code view: line numbers, colours for the language, text you can select and copy. CodeMirror 6, loaded
// only when a code file is opened (see FileTab). Colours come from the cockpit's tokens, so light and dark just work.
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { highlight, theme } from './editor-style';
import { languageFor } from './languages';

/** Lines the person has selected: 1-based, with the text. */
export interface CodeSelection {
  from: number;
  to: number;
  text: string;
}

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
