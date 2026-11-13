import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Shared by the phone-core evidence scenarios: the phone opens in a conversation; the drawer and the composer are shot
// from there. No default export, so the registry skips this file.
export type Shot = 'chat' | 'drawer' | 'composer';

export function phoneCoreScenario(shot: Shot, theme: 'dark' | 'light'): HarnessScenario {
  return {
    name: `phone-core-${shot}-${theme}`,
    route: 'phone',
    window: { width: 390, height: 844 },
    theme,
    phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 } },
    after: async (dom) => {
      await dom.waitFor('.ph-conv');
      await dom.sleep(600);
      if (shot === 'drawer') {
        await dom.click('.ph-head-menu');
        await dom.waitFor('.ph-drawer');
        await dom.sleep(500);
      }
      if (shot === 'composer') {
        const field = document.querySelector<HTMLTextAreaElement>('[data-testid="phone-composer"] textarea');
        if (field) {
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
          set.call(field, 'Thanks. Please also add a test for the case where the session is missing,\nand run the whole suite once more before you stop.');
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.focus();
        }
        await dom.sleep(500);
      }
    },
  };
}
