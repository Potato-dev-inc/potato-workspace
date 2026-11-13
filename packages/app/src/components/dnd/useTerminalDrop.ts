// A terminal pane takes dropped files: the path is typed at the prompt, in quotes when it needs them, followed by a
// space. Enter is never pressed, so the person looks at the line first. Works for files dragged in from Windows
// (lib/fileDrop) and for files dragged from the app's own Changes list (the drag layer).
import { useEffect, useId, useState, type RefObject } from 'react';
import { draggedFilePath, promptText } from '../../lib/dropFiles';
import { registerFileDrop } from '../../lib/fileDrop';
import { tauri } from '../../lib/tauri';
import { registerDropZone, useDragOver } from './dragStore';

/** Returns whether a file is being dragged over the pane right now (to draw the outline). */
export function useTerminalDrop(paneId: string, host: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const id = useId();
  const draggedOver = useDragOver(`terminal-${id}`);
  const [fileOver, setFileOver] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const rect = () => host.current?.getBoundingClientRect() ?? null;
    const type = (text: string) => {
      if (text) void tauri.writeInput(paneId, text, false).catch(() => undefined);
    };
    const offFile = registerFileDrop({ id: `terminal-${id}`, getRect: rect, onOver: setFileOver, onDrop: (paths) => type(promptText(paths)) });
    const offDrag = registerDropZone({
      id: `terminal-${id}`,
      accepts: (p) => p.kind === 'file',
      getRect: rect,
      onDrop: (p) => {
        void draggedFilePath(p).then((path) => (path ? type(promptText([path])) : undefined));
      },
    });
    return () => {
      offFile();
      offDrag();
    };
  }, [paneId, host, enabled, id]);
  return draggedOver || fileOver;
}
