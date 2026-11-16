// The browser bar (B, "open the browser myself"): back, forward, reload and an address box on top of a browser window.
// Injected only into the agent browser's window (never the app's own). Like the agent bar it keeps a closed shadow
// root and hands the person's clicks back to Rust through a queue Rust pulls (`take`); the page can read nothing from
// it. The key and the words just below are filled in by `chrome::script` (Rust).
(function () {
  'use strict';
  var KEY = __PM_CHROME_KEY__;
  var STR = __PM_CHROME_STR__;
  var H = 36;
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
  var shownUrl = '';
  var editing = false;
  // The start page's box asks for the focus once (see `render`); the person's own click or key ends the asking.
  var startDone = false;
  var acted = false;

  function push(kind, url) {
    if (queue.length < 20) queue.push({ kind: kind, url: url === undefined ? '' : String(url).slice(0, 2000) });
  }

  function el(tagName, css, text) {
    var node = document.createElement(tagName);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, title, kind) {
    var b = el('button', 'all:unset;cursor:pointer;width:28px;height:28px;display:grid;place-items:center;border-radius:6px;font:16px/1 system-ui,Segoe UI,sans-serif;color:#d8d4cf', label);
    b.setAttribute('title', title);
    b.setAttribute('aria-label', title);
    b.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      e.stopPropagation();
      push(kind);
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
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;height:' + H + 'px;z-index:2147483646';
    var root = host.attachShadow({ mode: 'closed' });
    var bar = el('div', 'box-sizing:border-box;display:flex;align-items:center;gap:4px;height:' + H + 'px;padding:0 8px;background:#1e1c1a;border-bottom:1px solid #3a3733;font:13px/18px system-ui,Segoe UI,sans-serif');
    var input = el('input', 'flex:1;min-width:0;height:26px;box-sizing:border-box;padding:0 10px;border:1px solid #3a3733;border-radius:13px;background:#282623;color:#f0ece6;font:13px/18px system-ui,Segoe UI,sans-serif;outline:none');
    input.setAttribute('type', 'text');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', S.address);
    input.setAttribute('placeholder', S.placeholder);
    input.addEventListener('focus', function () {
      editing = true;
      input.style.borderColor = '#d9a066';
      input.select();
    });
    input.addEventListener('blur', function () {
      editing = false;
      input.style.borderColor = '#3a3733';
      input.value = shownUrl;
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.isTrusted) {
        push('go', input.value);
        input.blur();
      }
    });
    var note = el('span', 'flex:none;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f2756b;font:12px/18px system-ui,Segoe UI,sans-serif');
    bar.appendChild(button('←', S.back, 'back'));
    bar.appendChild(button('→', S.forward, 'forward'));
    bar.appendChild(button('↻', S.reload, 'reload'));
    bar.appendChild(input);
    // "Back to side pane": shown only while the page is an artifact tab (Rust says so in the view).
    var side = el('button', 'all:unset;cursor:pointer;flex:none;height:26px;padding:0 10px;border:1px solid #3a3733;border-radius:13px;color:#f0ece6;font:12px/26px system-ui,Segoe UI,sans-serif;white-space:nowrap;display:none', S.side);
    side.setAttribute('aria-label', S.side);
    side.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      e.stopPropagation();
      push('side');
    });
    // "Mark up": shown only when the Labs switch is on (Rust says so in the view).
    var mark = el('button', 'all:unset;cursor:pointer;flex:none;height:26px;padding:0 10px;border:1px solid #3a3733;border-radius:13px;color:#f0ece6;font:12px/26px system-ui,Segoe UI,sans-serif;white-space:nowrap;display:none', S.mark);
    mark.setAttribute('aria-label', S.mark);
    mark.addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      e.stopPropagation();
      push('mark');
    });
    bar.appendChild(note);
    bar.appendChild(mark);
    bar.appendChild(side);
    root.appendChild(bar);
    ui = { input: input, note: note, side: side, mark: mark };
    parent.appendChild(host);
    try {
      parent.style.setProperty('margin-top', H + 'px', 'important');
    } catch (e) {}
  }

  function render(view) {
    ensure();
    if (!ui) return;
    shownUrl = view.url || '';
    if (!editing) ui.input.value = shownUrl;
    ui.note.textContent = view.error ? S[view.error] || S.errBad : '';
    ui.side.style.display = view.side ? 'block' : 'none';
    ui.mark.style.display = view.mark ? 'block' : 'none';
    ui.input.readOnly = !!view.side;
    // On the app's own start page the box is ready for typing: the focus is asked for only while nothing else holds it
    // and the person has not touched the page yet (a window that is still opening cannot take it at once). Once the box
    // has it, or anything else has it (the mark-up bar, the page), or the person has clicked or typed, it is never
    // asked for again: the bar must not take the focus back on later ticks.
    if (view.start && !startDone) {
      var held = document.activeElement;
      if (held === host) startDone = true;
      else if (held && held !== document.body && held !== document.documentElement) startDone = true;
      else if (!acted) {
        try {
          ui.input.focus();
        } catch (e) {}
        if (document.activeElement === host) startDone = true;
      }
    }
  }

  // After that only the person's own click, key press or Ctrl+L moves the focus to the box.
  document.addEventListener(
    'pointerdown',
    function (e) {
      if (e.isTrusted !== false) acted = true;
    },
    true,
  );
  document.addEventListener(
    'keydown',
    function (e) {
      if (!e.isTrusted) return;
      acted = true;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'l' && ui) {
        e.preventDefault();
        try {
          ui.input.focus();
        } catch (x) {}
      }
    },
    true,
  );

  var api = {
    set: function (json) {
      try {
        render(JSON.parse(json));
      } catch (e) {}
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
  // Drawn at once with what the page says its address is, so the bar is there before Rust's first answer.
  render({ url: String(location.href) === 'about:blank' ? '' : String(location.href), error: '' });
})();
