// What the sidebar does with "Make helper of...": the rules (lib/helperAdopt.ts) applied to the panes on screen, the call to the
// desktop shell, and the Undo bar. One hook, so the Sidebar only has to hold the result.
import type { PaneInfo } from '@potato-workspace/shared';
import { useT } from '../../i18n';
import { adoptRefusal, adoptTargets, type AdoptApi, type AdoptPane } from '../../lib/helperAdopt';
import { errorSentence } from '../../lib/sayError';
import { showUndo } from '../../lib/undo-bar';

export interface AdoptControl {
  /** Why `childId` cannot become a helper of `parentId` (a message key), or null. */
  refusal: (childId: string, parentId: string) => ReturnType<typeof adoptRefusal>;
  /** The main agents `id` could help, for the row menu. */
  targets: (id: string) => { id: string; name: string }[];
  /** Makes `childId` a helper of `parentId` (refusals are said in a notice). Undo is on the bar. */
  adopt: (childId: string, parentId: string) => Promise<void>;
  /** The agent is a main agent again (Undo puts it back under its old parent). */
  release: (id: string) => Promise<void>;
  /** The agent is a helper of someone (it can be made a main agent again). */
  isHelper: (id: string) => boolean;
}

export function useAdopt(args: {
  panes: readonly { info: Pick<PaneInfo, 'id' | 'cwd' | 'parent_pane_id'> }[];
  projectOf: (cwd: string) => string;
  nameOf: (id: string) => string;
  api: AdoptApi;
  notify: (text: string) => void;
}): AdoptControl {
  const t = useT();
  const { panes, projectOf, nameOf, api, notify } = args;
  const all: AdoptPane[] = panes.map((p) => ({ id: p.info.id, parent: p.info.parent_pane_id || null, project: projectOf(p.info.cwd) }));
  const find = (id: string) => all.find((p) => p.id === id);
  const refusal: AdoptControl['refusal'] = (childId, parentId) => adoptRefusal(find(childId), find(parentId), all);
  const change = async (child: string, parent: string | null) => {
    try {
      await api.setHelperOf(child, parent);
      return true;
    } catch (e) {
      notify(errorSentence(e, t('adopt.failed')));
      return false;
    }
  };
  return {
    refusal,
    targets: (id) => adoptTargets(find(id), all).map((p) => ({ id: p.id, name: nameOf(p.id) })),
    isHelper: (id) => Boolean(find(id)?.parent),
    adopt: async (childId, parentId) => {
      const why = refusal(childId, parentId);
      if (why) {
        notify(t(why));
        return;
      }
      if (!(await change(childId, parentId))) return;
      showUndo({
        text: t('adopt.done', { name: nameOf(childId), parent: nameOf(parentId) }),
        failText: t('adopt.failed'),
        undo: () => api.setHelperOf(childId, null),
      });
    },
    release: async (id) => {
      const before = find(id)?.parent ?? null;
      if (!before || !(await change(id, null))) return;
      showUndo({ text: t('adopt.undone', { name: nameOf(id) }), failText: t('adopt.failed'), undo: () => api.setHelperOf(id, before) });
    },
  };
}
