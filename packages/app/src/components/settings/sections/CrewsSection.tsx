// Settings > Helpers > Crews: shown only while Labs "Crews" (crews_enabled) is on.
// The page is loaded when it is opened: an early feature does not weigh on the main bundle.
import { lazy, Suspense } from 'react';
import type { RowDef } from '../model';

const CrewsPage = lazy(() => import('../blocks/CrewsPage').then((m) => ({ default: m.CrewsPage })));

export const crewsRows: RowDef[] = [
  {
    id: 'crews-page',
    group: 'Crews',
    label: 'Crews',
    hint: 'Your saved crews of agents. Read-only for now.',
    keywords: 'crews crew team roles agents orchestrator checker difficulty routing standby workers canvas',
    labsFlag: 'crews_enabled',
    render: () => (
      <Suspense fallback={null}>
        <CrewsPage />
      </Suspense>
    ),
  },
];
