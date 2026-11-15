import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { PetMoodPreview } from '../pet-mood-preview';
import type { HarnessScenario } from '../types';
import '../../styles/pet.css';

// Desktop Potato wearing the default companion's saved mood (seven cells).
const s: HarnessScenario = {
  name: 'small112-pet-mood-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 640 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(PetMoodPreview));
    await dom.sleep(700);
  },
};
export default s;
