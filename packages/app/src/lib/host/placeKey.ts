// A pane's id as THIS screen keeps it. A pane of this PC keeps its own id (nothing on disk migrates); a pane of another PC is
// `dev:<node>:<id>`, so two PCs' ids never meet in drafts, remembered tabs or any map keyed by pane. Only the host turns the key
// back into the far PC's own id (on the way out) and into the key again (on the way in); a component never splits one.
import type { Place } from './host';

/** Whether this place is another PC (a screen that only changes a sentence uses this, never the place itself). */
export const onAnotherPc = (place: Place): boolean => place.kind === 'pc';

export const placeKey = (place: Place, id: string): string => (place.kind === 'pc' ? `dev:${place.node}:${id}` : id);

/** The far PC's own id of `key`; an id that is not this node's key is returned as it is. */
export const idOfKey = (node: string, key: string): string => {
  const prefix = `dev:${node}:`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
};
