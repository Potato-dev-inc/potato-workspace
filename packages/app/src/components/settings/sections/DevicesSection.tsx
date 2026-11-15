// Settings > Devices: its own page, shown only while Labs "Devices" (devices_enabled) is on.
// The page is loaded when it is opened: an early feature does not weigh on the main bundle.
import { lazy, Suspense } from 'react';
import type { RowDef } from '../model';
import { movedToConnect } from '../../connect/movedRow';

const DevicesPage = lazy(() => import('../../devices/DevicesPage').then((m) => ({ default: m.DevicesPage })));

export const devicesRowsOriginal: RowDef[] = [
  {
    id: 'devices-page',
    group: 'Devices',
    label: 'Devices',
    hint: 'Pair another PC and run a chat or a terminal on it.',
    keywords: 'devices phones paired phone pair computer pc second remote run chat terminal code relay route far away nearby where',
    labsFlag: 'devices_enabled',
    render: (env) => (
      <Suspense fallback={null}>
        <DevicesPage onSaved={env.markSaved} onOpenPhone={env.openRow ? () => env.openRow?.('pairing') : undefined} />
      </Suspense>
    ),
  },
];

/** In the cockpit other PCs live on Connect > My PCs; this row links there. */
export const devicesRows: RowDef[] = movedToConnect(devicesRowsOriginal, ['devices-page'], 'pcs');
