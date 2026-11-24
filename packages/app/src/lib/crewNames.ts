// The two ready-made crews that come with the app have names in the app's language. Any other crew keeps the name it has.
import { t } from '../i18n';

export function crewName(crew: { slug: string; name: string }): string {
  if (crew.slug === 'template:our-way') return t('r15.crew.ourWay');
  if (crew.slug === 'template:how-we-work') return t('r15.crew.howWeWork');
  if (crew.slug === 'starter:builder-reviewer') return t('r23ui.crew.builderReviewer');
  if (crew.slug === 'starter:fix-the-tests') return t('r23ui.crew.fixTheTests');
  if (crew.slug === 'starter:research-write') return t('r23ui.crew.researchWrite');
  return crew.name;
}
