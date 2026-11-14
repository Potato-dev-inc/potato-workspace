// An artifact open beside the chat is a tab of the pane, in the same row as the open files (`file-tabs.ts`). Its tab
// path is `artifact:<id>`; this file keeps the title the tab shows, and opens and closes it.
import { closeFileTab, openFileTab } from './file-tabs';

const PREFIX = 'artifact:';
const titles = new Map<string, string>();

/** The tab path of an artifact. */
export const artifactTabPath = (id: string): string => `${PREFIX}${id}`;

/** The artifact id a tab path names, or null when the tab is a file. */
export function artifactIdOfPath(path: string): string | null {
  return path.startsWith(PREFIX) ? path.slice(PREFIX.length) : null;
}

/** What the tab row shows for a tab path: the artifact's title (its id until the title is known). */
export function artifactTabTitle(path: string): string {
  const id = artifactIdOfPath(path);
  return id === null ? path : (titles.get(path) ?? id);
}

export function openArtifactTab(paneId: string, id: string, title: string): void {
  titles.set(artifactTabPath(id), title);
  openFileTab(paneId, artifactTabPath(id));
}

export function closeArtifactTab(paneId: string, id: string): void {
  closeFileTab(paneId, artifactTabPath(id));
}

/** Keeps the shown title current when the agent renames a page. */
export function noteArtifactTitle(id: string, title: string): void {
  titles.set(artifactTabPath(id), title);
}
