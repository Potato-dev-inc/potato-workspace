import type { HarnessScenario } from '../types';
import { setSpeak } from '../../lib/companionSpeak';

// The companion's page with the Discord bot card (Labs) in the saved-token state, light.
const s: HarnessScenario = {
  name: 'discord-bot-light',
  route: 'cockpit',
  companion: 'idle',
  companionBody: true,
  companionDiscord: true,
  theme: 'light',
  window: { width: 1280, height: 1000 },
  after: async (dom) => {
    await dom.sleep(800);
    setSpeak({ on: false, offered: true });
    await dom.sleep(200);
    document.querySelector<HTMLButtonElement>('.ck-companion-row')?.click();
    await dom.sleep(1000);
    document.getElementById('ck-companion-discord-title')?.scrollIntoView({ block: 'start' });
    await dom.sleep(300);
  },
};
export default s;
