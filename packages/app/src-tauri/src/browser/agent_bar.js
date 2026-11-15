// The agent bar (N5-23): a thin orange bar on top of a preview page while an agent uses it.
// Injected only into preview windows (never the app's own). It draws only when Rust asks (`show`), keeps its
// own closed shadow root, and hands the person's clicks back to Rust by a queue Rust pulls (`take`); the page itself
// can read nothing from it. The key and the words just below are filled in by `bar::script` (Rust).
(function () {
  'use strict';
  var KEY = __PM_BAR_KEY__;
  var STR = __PM_BAR_STR__;
  try {
    if (window.top !== window.self || window[KEY]) return;
  } catch (e) {
    return;
  }
  var tag = String((navigator && navigator.language) || 'en').toLowerCase();
  var zh = tag === 'zh-tw' || tag === 'zh-hk' || tag === 'zh-mo' || tag.indexOf('zh-hant') === 0;
  var S = zh ? STR['zh-TW'] : STR.en;
  var queue = [];
  var host = null;
  var ui = null;
  var lastInput = 0;
  var view = null;
  var open = false;

  function push(kind) {
    if (queue.length < 50) queue.push({ kind: kind, at: Date.now() });
  }

  function el(tagName, css, text) {
    var node = document.createElement(tagName);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, kind) {
    var b = el('button', 'all:unset;cursor:pointer;padding:2px 10px;margin-left:6px;border-radius:5px;font:600 12px/18px system-ui,Segoe UI,sans-serif;background:rgba(0,0,0,.22);color:#fff', text);
    b.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      e.stopPropagation();
      if (kind === 'steps') {
        open = !open;
        render();
      } else {
        push(kind);
      }
    });
    return b;
  }

  function ensure() {
    if (host && host.isConnected) return;
    var parent = document.documentElement || document.body;
    if (!parent) return;
    host = document.createElement('div');
    // Not part of the page for anyone reading it as a list (an agent's read must never show these buttons).
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none';
    var root = host.attachShadow({ mode: 'closed' });
    var bar = el('div', 'pointer-events:none;display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;font:600 12px/18px system-ui,Segoe UI,sans-serif;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35)');
    var dot = el('span', 'width:8px;height:8px;border-radius:50%;background:#fff;flex:none');
    var label = el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
    var actions = el('span', 'pointer-events:auto;display:flex;flex:none');
    bar.appendChild(dot);
    bar.appendChild(label);
    bar.appendChild(actions);
    var panel = el('div', 'pointer-events:auto;max-height:40vh;overflow:auto;background:#1b1b1b;color:#e8e8e8;font:12px/18px system-ui,Segoe UI,sans-serif;padding:6px 12px;display:none');
    var mark = el('div', 'position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(232,120,40,.45);border:2px solid #e87828;pointer-events:none;opacity:0;transition:opacity .6s');
    root.appendChild(bar);
    root.appendChild(panel);
    root.appendChild(mark);
    ui = { bar: bar, dot: dot, label: label, actions: actions, panel: panel, mark: mark };
    parent.appendChild(host);
  }

  function render() {
    if (!view || !view.visible) {
      if (host) host.style.display = 'none';
      return;
    }
    ensure();
    if (!ui) return;
    host.style.display = '';
    var paused = view.state === 'paused';
    ui.bar.style.background = paused ? '#5a5a5a' : '#e87828';
    ui.dot.style.opacity = paused ? '0.5' : '1';
    ui.label.textContent = paused ? (view.reason === 'stopped' ? S.stopped : S.paused) : S.using.replace('{agent}', view.agent || S.agent);
    while (ui.actions.firstChild) ui.actions.removeChild(ui.actions.firstChild);
    var steps = view.steps || [];
    if (steps.length) ui.actions.appendChild(button(S.steps.replace('{n}', String(steps.length)), 'steps'));
    ui.actions.appendChild(button(S.point, 'point'));
    if (paused) {
      ui.actions.appendChild(button(S.giveBack, 'giveback'));
    } else {
      ui.actions.appendChild(button(S.takeOver, 'takeover'));
      ui.actions.appendChild(button(S.stop, 'stop'));
    }
    ui.panel.style.display = open && steps.length ? '' : 'none';
    while (ui.panel.firstChild) ui.panel.removeChild(ui.panel.firstChild);
    steps.forEach(function (s) {
      ui.panel.appendChild(el('div', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis', s.n + '. ' + s.text));
    });
  }

  var api = {
    show: function (json) {
      try {
        view = JSON.parse(json);
      } catch (e) {
        return;
      }
      render();
    },
    hide: function () {
      view = null;
      render();
    },
    // While the agent clicks: take the bar out of the way (its buttons must never catch the agent's click) and
    // show a soft dot where the click goes.
    hold: function (on, x, y) {
      if (!host || !ui) return;
      host.style.visibility = on ? 'hidden' : 'visible';
      if (!on) {
        if (typeof x === 'number' && typeof y === 'number') {
          ui.mark.style.left = x + 'px';
          ui.mark.style.top = y + 'px';
          ui.mark.style.opacity = '1';
          setTimeout(function () {
            if (ui) ui.mark.style.opacity = '0';
          }, 500);
        }
      }
    },
    take: function () {
      if (!queue.length) return null;
      return JSON.stringify(queue.splice(0, queue.length));
    },
  };
  try {
    Object.defineProperty(window, KEY, { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
  } catch (e) {
    return;
  }

  // The person's own clicks and keys. The agent's clicks arrive as trusted events too, so Rust tells them apart by
  // the time: it knows when it is acting and ignores what happened then.
  function person(e) {
    if (!e.isTrusted) return;
    if (host && e.target === host) return;
    var now = Date.now();
    if (now - lastInput < 150) return;
    lastInput = now;
    push('input');
  }
  window.addEventListener('pointerdown', person, true);
  window.addEventListener('keydown', person, true);
})();
