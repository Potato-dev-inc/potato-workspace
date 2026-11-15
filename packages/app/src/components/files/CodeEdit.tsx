// The code editor: the same look as the code view, but you can type, undo, find (Ctrl+F) and save (Ctrl+S).
// CodeMirror 6, loaded only when a person starts editing (see FileTab). The text is the editor's own while it is open:
// the screen gets every change through `onChange` and starts the editor over by changing `revision`.
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { indentOnInput, syntaxHighlighting } from '@codemirror/language';
import type { CodeSelection } from './CodeEditor';
import { editTheme, highlight, theme } from './editor-style';
import { languageFor } from './languages';

export function CodeEdit({
  path,
  initial,
  revision,
  onChange,
  onSave,
  onSelect,
}: {
  path: string;
  /** The text the editor starts with (read when it starts, and again when `revision` changes). */
  initial: string;
  revision: number;
  onChange: (text: string) => void;
  onSave: () => void;
  onSelect?: (selection: CodeSelection | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const calls = useRef({ onChange, onSave, onSelect });
  calls.current = { onChange, onSave, onSelect };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: initialRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          search({ top: true }),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                calls.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          syntaxHighlighting(highlight),
          theme,
          editTheme,
          language.of([]),
          EditorView.contentAttributes.of({ 'aria-label': path, 'aria-multiline': 'true' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) calls.current.onChange(u.state.doc.toString());
            if (!u.selectionSet) return;
            const main = u.state.selection.main;
            if (main.empty) return calls.current.onSelect?.(null);
            const doc = u.state.doc;
            calls.current.onSelect?.({ from: doc.lineAt(main.from).number, to: doc.lineAt(main.to).number, text: doc.sliceString(main.from, main.to) });
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
  }, [path, revision]);

  return <div ref={host} className="ck-fcode ck-fcode--edit" data-testid="file-edit" />;
}
