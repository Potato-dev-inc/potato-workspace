// Evidence for the agent browser's bar (N5-23): the real `agent_bar.js` that the preview windows get, run in the
// harness page with the words of `browser/bar.rs`, so the screenshots show what the person sees on top of a page.
import barJs from '../../src-tauri/src/browser/agent_bar.js?raw';
import type { HarnessDom } from './types';

const STR = {
  en: { using: '{agent} is using this page', agent: 'An agent', paused: 'You took over. The agent waits.', stopped: 'Stopped. The agent will not use this page.', takeOver: 'Take over', stop: 'Stop', giveBack: 'Give back', point: 'Point', steps: 'Steps ({n})' },
  'zh-TW': { using: '{agent} 正在使用這個頁面', agent: '代理程式', paused: '你接手了，代理程式在等待。', stopped: '已停止，代理程式不會再使用這個頁面。', takeOver: '我來接手', stop: '停止', giveBack: '交還', point: '指一下', steps: '步驟 ({n})' },
};

const STEPS = [
  { n: 1, text: 'Opened localhost:5173' },
  { n: 2, text: 'Read the page (refs)' },
  { n: 3, text: 'Clicked e4 (button "Add to cart").' },
  { n: 4, text: 'Read the console (errors): 1 entries' },
];

export type BarShot = 'driving' | 'paused' | 'stopped' | 'driving-zh';

const VIEWS: Record<BarShot, { state: string; reason: string }> = {
  driving: { state: 'driving', reason: '' },
  'driving-zh': { state: 'driving', reason: '' },
  paused: { state: 'paused', reason: 'took_over' },
  stopped: { state: 'paused', reason: 'stopped' },
};

/** Puts a small mock app page under the bar and draws the bar the way Rust tells it to. */
export async function drawBar(dom: HarnessDom, shot: BarShot): Promise<void> {
  await dom.sleep(300);
  document.body.innerHTML = '';
  const page = document.createElement('div');
  page.style.cssText = 'font:14px system-ui,sans-serif;padding:56px 32px;background:#fafafa;color:#222;min-height:100vh';
  page.innerHTML = '<h1 style="margin:0 0 12px">Shop</h1><p>Two items in your cart.</p><button style="padding:6px 14px">Add to cart</button> <button style="padding:6px 14px">Checkout</button>';
  document.body.appendChild(page);
  if (shot === 'driving-zh') Object.defineProperty(navigator, 'language', { get: () => 'zh-TW' });
  const key = `__pm_bar_demo_${shot}`;
  try {
    new Function(barJs.split('__PM_BAR_KEY__').join(JSON.stringify(key)).split('__PM_BAR_STR__').join(JSON.stringify(STR)))();
    const view = { visible: true, ...VIEWS[shot], agent: 'Claude Code', steps: STEPS };
    (window as unknown as Record<string, { show: (json: string) => void }>)[key].show(JSON.stringify(view));
  } catch (e) {
    page.textContent = `bar error: ${String(e)}`;
  }
  await dom.sleep(500);
}
