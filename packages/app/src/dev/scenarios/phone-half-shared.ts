import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// Shared by the phone half-built evidence scenarios (drawer foot with usage and state colours, Settings with the theme row,
// the rule line above the box). No default export, so the registry skips this file.
export type HalfShot = 'drawer' | 'settings' | 'rule' | 'loading';

export function phoneHalfScenario(shot: HalfShot, theme: 'dark' | 'light'): HarnessScenario {
  const panes = PHONE_PANES.map((p, i) => ({ ...p, status: i === 0 ? ('running' as const) : i === 1 ? ('waiting_input' as const) : ('idle' as const) }));
  return {
    name: `phone-half-${shot}-${theme}`,
    route: 'phone',
    window: { width: 390, height: 844 },
    theme,
    phonePanes: panes,
    phoneCaps: shot === 'rule' ? ['watch', 'answer', 'type'] : undefined,
    phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, chat: 'finished' },
    after: async (dom) => {
      await dom.waitFor('.ph-conv');
      await dom.sleep(700);
      if (shot === 'drawer' || shot === 'settings') {
        await dom.click('.ph-head-menu');
        await dom.waitFor('.ph-drawer');
        await dom.sleep(600);
      }
      if (shot === 'settings') {
        await dom.click('.ph-dsettings');
        await dom.waitFor('[data-testid="phone-theme"]');
        await dom.sleep(500);
      }
    },
  };
}
