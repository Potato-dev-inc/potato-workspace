import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { PetPreview } from '../pet-preview';
import type { HarnessScenario } from '../types';
import '../../styles/pet.css';

// Desktop Potato in each state (12 cells) on a mock dark desktop, light theme tokens, 1280 px wide.
const s: HarnessScenario = {
  name: 'pet-light-1280',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 940 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(PetPreview, { columns: 4 }));
    await dom.sleep(700);
  },
};
export default s;
