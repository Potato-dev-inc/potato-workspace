import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { WorkflowFarPreview } from '../workflow-far-preview';
import { rememberCrewStart } from '../../lib/crew-members';
import type { HarnessScenario } from '../types';

// P3.1: a workflow front's crew chip and workflow card on this PC and on another PC, side by side (light), see workflow-far-preview.tsx.
const s: HarnessScenario = {
  name: 'workflow-far-light',
  route: 'cockpit',
  theme: 'light',
  workflows: true,
  window: { width: 1280, height: 520 },
  after: async (dom) => {
    await dom.sleep(300);
    rememberCrewStart('wf', [{ role: 'Front', pane_id: 'front' }], 'Front', 'Research + Write');
    const host = document.createElement('div');
    document.body.prepend(host);
    createRoot(host).render(createElement(WorkflowFarPreview));
    await dom.sleep(800);
    document.querySelectorAll<HTMLElement>('[data-testid="wf-card-head"]').forEach((b) => b.click());
    await dom.sleep(500);
  },
};
export default s;
