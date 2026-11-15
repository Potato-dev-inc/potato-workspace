// Settings > Agents > Where agents start: whether the New agent page offers "Work on a copy". One switch for every project,
// and (for the current project) a choice that wins over it. Kept on this device. Hiding the option never touches a copy
// that already exists.
import { t, useT } from '../../../i18n';
import { useCopyOfferGlobal, useProjectOffer, type ProjectOffer } from '../../../lib/copyOffer';
import { Popup } from '../controls';
import type { RowDef } from '../model';
import { SettingRow, SettingToggle } from '../settings-ui';

function folderName(path: string): string {
  const parts = path.replace(/[\/]+$/, '').split(/[\/]/);
  return parts[parts.length - 1] || path;
}

function ProjectChoice({ project }: { project: string | null }) {
  const tr = useT();
  const [offer, setOffer] = useProjectOffer(project);
  if (!project) return null;
  return (
    <SettingRow label={tr('copyOffer.thisProject')}>
      <Popup aria-label={tr('copyOffer.projectAria')} title={folderName(project)} value={offer} onChange={(event) => setOffer(event.target.value as ProjectOffer)}>
        <option value="default">{tr('copyOffer.follow')}</option>
        <option value="on">{tr('copyOffer.always')}</option>
        <option value="off">{tr('copyOffer.never')}</option>
      </Popup>
    </SettingRow>
  );
}

function CopyOfferRows({ project }: { project: string | null }) {
  const [on, setOn] = useCopyOfferGlobal();
  return (
    <>
      <SettingToggle label={t('settings.row.copy-offer.label')} description={t('settings.row.copy-offer.hint')} checked={on} onChange={setOn} />
      <ProjectChoice project={project} />
    </>
  );
}

export const copyOfferRow: RowDef = {
  id: 'copy-offer',
  label: 'Offer "Work on a copy"',
  hint: 'Shows the "Work on a copy" switch when you start an agent. Off hides it.',
  keywords: 'work on a copy trial run separate copy worktree isolate offer show hide new agent keep throw away project',
  group: 'Where agents start',
  render: (env) => <CopyOfferRows project={env.projectPath} />,
};
