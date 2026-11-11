// Settings > Lend: its own page, shown only while Labs "Share an agent" (lend_enabled) is on.
// The page is loaded when it is opened: an early feature does not weigh on the main bundle.
import { lazy, Suspense } from 'react';
import type { RowDef } from '../model';

const LendPage = lazy(() => import('../blocks/LendPage').then((m) => ({ default: m.LendPage })));

export const lendRows: RowDef[] = [
  {
    id: 'lend-page',
    group: 'Share an agent',
    label: 'Lend an agent',
    hint: 'Lend your sign-in to another PC through this one, or borrow one.',
    keywords:
      'lend borrow share usage agent sign-in login profile profiles request revoke give back api key teammate my pcs limit expire hours',
    labsFlag: 'lend_enabled',
    render: (env) => (
      <Suspense fallback={null}>
        <LendPage onSaved={env.markSaved} />
      </Suspense>
    ),
  },
];
