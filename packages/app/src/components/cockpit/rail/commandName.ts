// The plain name of a command row: the name the agent gave it, else what it does ("Run the tests", "Dev server"),
// else the program's own name. The full command is only in the row's tip and in the output view; never a line to type.
import type { MessageKey, Vars } from '../../../i18n';
import type { FinishedCommand, PaneJob } from '../../../lib/pane-jobs';

type Translate = (key: MessageKey, vars?: Vars) => string;

export function commandName(job: Pick<PaneJob, 'title' | 'kind' | 'name'> | Pick<FinishedCommand, 'title' | 'kind' | 'name'>, t: Translate): string {
  if (job.title) return job.title;
  switch (job.kind) {
    case 'test':
      return t('rail.bg.kind.test');
    case 'build':
      return t('rail.bg.kind.build');
    case 'dev':
      return t('rail.bg.kind.dev');
    case 'install':
      return t('rail.bg.kind.install');
    default:
      return job.name;
  }
}
