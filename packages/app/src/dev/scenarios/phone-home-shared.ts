// window: { width: 390, height: 844 } (the registry reads the size from this file)
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// Shared by the phone-home evidence scenarios (the Inbox part on the Agents screen, the drawer's Ready helpers). No default
// export, so the registry skips this file.
export function phoneHomeScenario(shot: 'inbox' | 'drawer', theme: 'dark' | 'light'): HarnessScenario {
  return {
    name: `phone-home-${shot}-${theme}`,
    route: 'phone',
    window: { width: 390, height: 844 },
    theme,
    phonePanes: PHONE_PANES,
    phone: { digest: false, questions: false, attention: { blocking: 0 }, team: {}, home: true },
    after: async (dom) => {
      await dom.waitFor('.ph-head-menu');
      await dom.sleep(500);
      // The What's new sheet opens by itself once: close it.
      Array.from(document.querySelectorAll<HTMLButtonElement>('.ph-btn--primary')).find((b) => b.textContent === 'Done')?.click();
      await dom.sleep(400);
      await dom.click('.ph-head-menu');
      await dom.waitFor('[data-testid="drawer-ready"]');
      if (shot === 'inbox') document.querySelector('[data-testid="phone-done-today"]')?.scrollIntoView({ block: 'start' });
      await dom.sleep(600);
    },
  };
}
