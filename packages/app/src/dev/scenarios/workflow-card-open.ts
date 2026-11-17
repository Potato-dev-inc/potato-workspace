import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { WorkflowCardPreview } from '../workflow-card-preview';
import type { HarnessScenario } from '../types';

// The "Using workflow" card at the top of a workflow chat, open: see workflow-card-preview.tsx.
const s: HarnessScenario = {
  name: 'workflow-card-open',
  route: 'cockpit',
  window: { width: 900, height: 700 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(WorkflowCardPreview, { open: true }));
    await dom.sleep(1200);
  },
};
export default s;
