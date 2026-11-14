import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { ChatMarkdown } from '../../components/chat/ChatMarkdown';
import type { HarnessScenario } from '../types';

// Fold long code: a 150-line code block shows 30 lines and "Show all 150 lines", then opened.
const code = Array.from({ length: 150 }, (_, i) => `const value${i + 1} = compute(${i + 1}); // line ${i + 1}`).join('\n');
const text = 'Here is the whole file:\n\n```ts\n' + code + '\n```\n\nThat is everything. The answer below the code stays readable.';
const s: HarnessScenario = {
  name: 'fold-code-open',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 1500 },
  after: async (dom) => {
    await dom.sleep(300);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;padding:12px;background:var(--bg,#111)';
    host.className = 'cockpit';
    document.body.appendChild(host);
    createRoot(host).render(createElement(ChatMarkdown, { text }));
    await dom.sleep(400);
    host.querySelector<HTMLButtonElement>('[data-testid="fold-toggle"]')?.click();
    await dom.sleep(300);
  },
};
export default s;
