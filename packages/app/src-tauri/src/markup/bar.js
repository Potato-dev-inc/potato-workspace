// The mark-up bar for the agent browser's window (the twin of the app's own bar, `components/markup/`). Injected only into
// the agent browser's windows, only in the TOP document, and it keeps a closed shadow root in the page: the page cannot
// read it, click it or draw on it. Like the agent bar it never pushes anything out: Rust pulls the person's actions
// (`take`) and pushes state in (`set`). The page cannot reach Potato Workspace.
//
// Icons, sizes, keys, colours and the outline's spring come from the shared spec (`markup-spec.json`), which the app's
// bar reads too; a test fails if the two drift. The key, the spec and the words are filled in by `markup::bar::script`.
(function () {
  'use strict';
  var KEY = __PM_MARKUP_KEY__;
  var SPEC = __PM_MARKUP_SPEC__;
  var STR = __PM_MARKUP_STR__;
  var LOGOS = __PM_MARKUP_LOGOS__;
  var TOP = __PM_MARKUP_TOP__;
  try {
    if (window.top !== window.self || window[KEY]) return;
  } catch (e) {
    return;
  }
  // Built-ins taken before any page script can change them.
  var doc = document;
  var create = Document.prototype.createElement;
  var createNS = Document.prototype.createElementNS;
  var atPoint = Document.prototype.elementFromPoint;
  var rectOf = Element.prototype.getBoundingClientRect;
  var listen = EventTarget.prototype.addEventListener;
  var setT = window.setTimeout.bind(window);
  var clearT = window.clearTimeout.bind(window);
  var parse = JSON.parse;
  var stringify = JSON.stringify;
  var NS = 'http://www.w3.org/2000/svg';
  var tag = String((navigator && navigator.language) || 'en').toLowerCase();
  var zh = tag === 'zh-tw' || tag === 'zh-hk' || tag === 'zh-mo' || tag.indexOf('zh-hant') === 0;
  var S = zh ? STR['zh-TW'] : STR.en;
  var THEMES = {
    dark: { bar: '#282623', line: '#3a3733', text: '#f0ece6', dim: '#b9b4ac', hover: '#34312d', accent: '#f29a3c', accentSoft: 'rgba(242,154,60,.16)', accentFg: '#1b1409' },
    light: { bar: '#ffffff', line: '#d3d1ca', text: '#1d1d1d', dim: '#5f5d57', hover: '#efeeea', accent: '#9c4804', accentSoft: 'rgba(156,72,4,.12)', accentFg: '#ffffff' },
  };
  var T = THEMES.dark;
  var queue = [];
  var host = null;
  var ui = null;
  var typing = false;
  var shown = false;
  var less = false;
  var st = {
    open: false,
    tool: 'select',
    shape: 'rect',
    color: SPEC.colors[0].value,
    marks: [],
    redo: [],
    popup: null,
    sending: false,
    draft: null,
    nextId: 1,
    hover: null,
    status: '',
    thumb: '',
    taking: false,
    noPicture: false,
    request: '',
    needText: false,
    targets: [],
    to: '',
    toOpen: false,
    owner: '',
    width: 0,
  };

  function push(ev) {
    if (queue.length < 30) queue.push(ev);
  }
  function css(node, text) {
    node.style.cssText = text;
    return node;
  }
  function el(name, style, text) {
    var n = create.call(doc, name);
    if (style) css(n, style);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function svgEl(name, attrs, parent) {
    var n = createNS.call(doc, NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function icon(name, size) {
    var s = svgEl('svg', { viewBox: '0 0 20 20', width: size || 17, height: size || 17, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    svgEl('path', { d: SPEC.icons[name] }, s);
    return s;
  }
  function one(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) : s;
  }
  function reduced() {
    if (less) return true;
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }
  function drawTool() {
    return st.tool === 'pen' || st.tool === 'shape';
  }
  function takesMouse() {
    return st.open && (st.tool === 'pen' || st.tool === 'shape' || st.tool === 'text');
  }

  // ---- describing a page element (the same facts the app's Select tool takes) ----
  function path(node) {
    var parts = [];
    var i = 0;
    while (node && node.nodeType === 1 && i < 4) {
      var p = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]{0,40}$/.test(node.id)) {
        parts.unshift(p + '#' + node.id);
        break;
      }
      var c = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(function (x) { return /^[A-Za-z_][\w-]{0,30}$/.test(x); }).slice(0, 2) : [];
      if (c.length) p += '.' + c.join('.');
      parts.unshift(p);
      node = node.parentElement;
      i++;
    }
    return parts.join(' > ');
  }
  function describe(node) {
    var attrs = [];
    ['id', 'aria-label', 'role', 'name', 'data-testid'].forEach(function (n) {
      var v = node.getAttribute && node.getAttribute(n);
      if (v) attrs.push({ name: n, value: one(v, 80) });
    });
    return { tag: node.tagName.toLowerCase(), selector: one(path(node), 200), text: one(node.innerText || node.textContent || '', 160), attrs: attrs };
  }
  function pageNodeAt(x, y) {
    // The bar's host takes no mouse, so the page element is what is under the point.
    var n = atPoint.call(doc, x, y + TOP);
    return n && n !== host && n !== doc.documentElement && n !== doc.body ? n : null;
  }
  function boxOf(node) {
    var r = rectOf.call(node);
    return { x: r.left, y: r.top - TOP, w: r.width, h: r.height };
  }
  function isFrame(node) {
    return node.tagName === 'IFRAME' || node.tagName === 'FRAME';
  }

  // ---- marks ----
  function addMark(m) {
    m.id = st.nextId++;
    st.marks.push(m);
    st.redo = [];
    st.draft = null;
    if (st.marks.length === 1) say(S.held);
    drawMarks();
    refresh();
  }
  function undo() {
    if (!st.marks.length) return;
    st.redo.push(st.marks.pop());
    if (!st.marks.length) st.sending = false;
    drawMarks();
    refresh();
  }
  function redo() {
    if (!st.redo.length) return;
    st.marks.push(st.redo.pop());
    drawMarks();
    refresh();
  }
  function clearMarks(silent) {
    st.marks = [];
    st.redo = [];
    st.sending = false;
    st.draft = null;
    st.thumb = '';
    drawMarks();
    refresh();
    if (!silent) say(S.cleared);
  }
  function anchor(m) {
    if (m.type === 'pen') return m.pts[0];
    if (m.type === 'text') return { x: m.x1, y: m.y1 - 15 };
    if (m.type === 'arrow') return { x: m.x1, y: m.y1 };
    return { x: Math.min(m.x1, m.x2), y: Math.min(m.y1, m.y2) };
  }
  function probe(m) {
    if (m.type === 'pen') return m.pts[Math.floor(m.pts.length / 2)] || { x: m.x1, y: m.y1 };
    if (m.type === 'text') return { x: m.x1, y: m.y1 + 14 };
    if (m.type === 'arrow') return { x: m.x2, y: m.y2 };
    return { x: (m.x1 + m.x2) / 2, y: (m.y1 + m.y2) / 2 };
  }
  function shapeInto(g, m) {
    var sw = SPEC.sizes.stroke;
    function both(name, geo) {
      [{ stroke: 'rgba(255,255,255,.9)', w: sw + SPEC.sizes.halo, dash: false }, { stroke: m.color, w: sw, dash: m.type === 'pick' }].forEach(function (l) {
        var a = { fill: 'none', stroke: l.stroke, 'stroke-width': l.w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        for (var k in geo) a[k] = geo[k];
        if (l.dash) a['stroke-dasharray'] = '6 4';
        svgEl(name, a, g);
      });
    }
    var x = Math.min(m.x1, m.x2);
    var y = Math.min(m.y1, m.y2);
    var w = Math.abs(m.x2 - m.x1);
    var h = Math.abs(m.y2 - m.y1);
    if (m.type === 'pen') {
      both('path', { d: 'M' + m.pts.map(function (p) { return p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' L') });
    } else if (m.type === 'rect' || m.type === 'pick') {
      both('rect', { x: x, y: y, width: w, height: h, rx: 4 });
    } else if (m.type === 'ellipse') {
      both('ellipse', { cx: (m.x1 + m.x2) / 2, cy: (m.y1 + m.y2) / 2, rx: w / 2, ry: h / 2 });
    } else if (m.type === 'arrow') {
      var a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
      var L = 12;
      both('path', { d: 'M' + m.x1 + ' ' + m.y1 + ' L' + m.x2 + ' ' + m.y2 + ' M' + (m.x2 - L * Math.cos(a - 0.45)) + ' ' + (m.y2 - L * Math.sin(a - 0.45)) + ' L' + m.x2 + ' ' + m.y2 + ' L' + (m.x2 - L * Math.cos(a + 0.45)) + ' ' + (m.y2 - L * Math.sin(a + 0.45)) });
    } else if (m.type === 'text') {
      svgEl('rect', { x: m.x1, y: m.y1 - 15, width: m.text.length * 7.1 + 14, height: 22, rx: 5, fill: '#fff', stroke: m.color, 'stroke-width': 2 }, g);
      var t = svgEl('text', { x: m.x1 + 7, y: m.y1, 'font-size': 13, 'font-family': 'Segoe UI, system-ui, sans-serif', fill: '#111' }, g);
      t.textContent = m.text;
    }
  }
  function drawMarks() {
    if (!ui) return;
    while (ui.ink.firstChild) ui.ink.removeChild(ui.ink.firstChild);
    st.marks.forEach(function (m, i) {
      var g = svgEl('g', {}, ui.ink);
      shapeInto(g, m);
      var p = anchor(m);
      svgEl('circle', { cx: p.x, cy: p.y, r: SPEC.sizes.badge, fill: m.color, stroke: '#fff', 'stroke-width': 1.5 }, g);
      var t = svgEl('text', { x: p.x, y: p.y + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, 'font-family': 'Segoe UI, system-ui, sans-serif', fill: '#fff' }, g);
      t.textContent = String(i + 1);
    });
    if (st.draft) shapeInto(svgEl('g', {}, ui.ink), st.draft);
  }

  // ---- the outline of the Select tool: one box that is moved, never rebuilt ----
  var blobShown = false;
  function blob(h) {
    var b = ui.blob;
    if (!h) {
      blobShown = false;
      b.style.opacity = '0';
      return;
    }
    ui.blobLabel.textContent = h.label;
    function place(x, y, w, hh) {
      b.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      b.style.width = w + 'px';
      b.style.height = hh + 'px';
    }
    if (reduced()) {
      b.style.transition = 'none';
      b.setAttribute('data-motion', 'off');
      place(h.x, h.y, h.w, h.h);
      b.style.opacity = '1';
      blobShown = true;
      return;
    }
    b.setAttribute('data-motion', 'spring');
    if (!blobShown) {
      b.style.transition = 'none';
      place(h.cx, h.cy, 0, 0);
      b.style.opacity = '0';
      void b.offsetWidth;
      blobShown = true;
    }
    var ease = SPEC.blob.ms + 'ms ' + SPEC.blob.curve;
    b.style.transition = 'transform ' + ease + ',width ' + ease + ',height ' + ease + ',opacity 90ms linear';
    place(h.x, h.y, h.w, h.h);
    b.style.opacity = '1';
  }

  // ---- the page while the bar is open ----
  function onMove(e) {
    if (!st.open || st.tool !== 'select' || !e.isTrusted) return;
    if (e.clientY < TOP) return blob(null);
    var n = pageNodeAt(e.clientX, e.clientY - TOP);
    if (!n) return blob(null);
    var b = boxOf(n);
    var t = one(n.innerText || n.textContent || '', 24);
    b.label = isFrame(n) ? S.frame : n.tagName.toLowerCase() + (t ? ' · ' + t : '');
    b.cx = e.clientX;
    b.cy = e.clientY - TOP;
    blob(b);
  }
  // The bar's own buttons sit inside `host` (a closed shadow root). A real click is composed, so the capture listeners on
  // the document see it first: those must let the bar's own events through, or no button ever gets its click.
  function ownBar(e) {
    return !!host && typeof e.composedPath === 'function' && e.composedPath().indexOf(host) >= 0;
  }
  function stopPage(e) {
    if (!st.open || !e.isTrusted || e.clientY < TOP || ownBar(e)) return;
    // A draw tool's layer uses pointer events itself; everything else is held back from the page.
    if (e.type.indexOf('pointer') === 0 && takesMouse()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function onClickCapture(e) {
    if (!st.open || !e.isTrusted || e.clientY < TOP || ownBar(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (st.tool !== 'select') return;
    var n = pageNodeAt(e.clientX, e.clientY - TOP);
    if (!n) return;
    var b = boxOf(n);
    var d = isFrame(n) ? { tag: n.tagName.toLowerCase(), selector: one(path(n), 200), text: '', attrs: [] } : describe(n);
    addMark({ type: 'pick', color: st.color, x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h, near: d });
  }
  function holdScroll(e) {
    if (st.open && st.marks.length && e.isTrusted) e.preventDefault();
  }

  // ---- the keys ----
  function onKey(e) {
    if (!e.isTrusted) return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && k === 'm') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return st.open ? closeBar() : openBar();
    }
    if (!st.open) return;
    if (k === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return escape();
    }
    if (typing || e.isComposing) return;
    var did = true;
    if (mod && k === 'z') (e.shiftKey ? redo : undo)();
    else if (mod && k === 'Enter') startSend();
    else if (mod || e.altKey) did = false;
    else if (k === 'v') setTool('select');
    else if (k === 'p') setTool('pen');
    else if (k === 't') setTool('text');
    else if (k === 'r' || k === 'a' || k === 'o') {
      st.shape = k === 'r' ? 'rect' : k === 'a' ? 'arrow' : 'ellipse';
      setTool('shape');
    } else did = false;
    if (did) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  function escape() {
    if (st.toOpen) st.toOpen = false;
    else if (st.draft) st.draft = null;
    else if (st.popup) st.popup = null;
    else if (st.sending) st.sending = false;
    else if (st.tool !== 'select') st.tool = 'select';
    else return closeBar();
    drawMarks();
    refresh();
  }

  // ---- drawing on the layer ----
  var live = null;
  var note = null;
  function pos(e) {
    return { x: e.clientX, y: e.clientY - TOP };
  }
  function down(e) {
    if (!takesMouse() || e.button !== 0 || !e.isTrusted) return;
    var p = pos(e);
    e.preventDefault();
    if (st.tool === 'text') {
      commitNote();
      note = { x: p.x, y: p.y };
      ui.note.value = '';
      css(ui.note, 'position:absolute;left:' + p.x + 'px;top:' + (p.y - 14) + 'px;min-width:150px;padding:3px 6px;border:2px solid ' + st.color + ';border-radius:5px;background:#fff;color:#111;font:13px system-ui,sans-serif;pointer-events:all;display:block');
      ui.note.focus();
      return;
    }
    try {
      ui.ink.setPointerCapture(e.pointerId);
    } catch (x) {}
    live = st.tool === 'pen' ? { type: 'pen', color: st.color, x1: p.x, y1: p.y, x2: p.x, y2: p.y, pts: [p] } : { type: st.shape, color: st.color, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    st.draft = live;
    drawMarks();
  }
  function move(e) {
    if (!live) return;
    var p = pos(e);
    if (live.type === 'pen') {
      var l = live.pts[live.pts.length - 1];
      if (Math.abs(p.x - l.x) + Math.abs(p.y - l.y) > 2) {
        live.pts.push(p);
        live.x2 = p.x;
        live.y2 = p.y;
      }
    } else {
      live.x2 = p.x;
      live.y2 = p.y;
      if (e.shiftKey && live.type !== 'arrow') {
        var d = Math.max(Math.abs(p.x - live.x1), Math.abs(p.y - live.y1));
        live.x2 = live.x1 + d * (p.x - live.x1 < 0 ? -1 : 1);
        live.y2 = live.y1 + d * (p.y - live.y1 < 0 ? -1 : 1);
      }
    }
    drawMarks();
  }
  function up() {
    var m = live;
    live = null;
    if (!m) return;
    var tiny = m.type === 'pen' ? m.pts.length < SPEC.sizes.penMinPoints : Math.abs(m.x2 - m.x1) + Math.abs(m.y2 - m.y1) < SPEC.sizes.tinyPx;
    st.draft = null;
    if (tiny) return drawMarks();
    addMark(m);
  }
  function commitNote() {
    if (!note) return;
    var v = one(ui.note.value, SPEC.sizes.noteMax);
    var at = note;
    note = null;
    ui.note.style.display = 'none';
    if (v) addMark({ type: 'text', color: st.color, x1: at.x, y1: at.y, x2: at.x, y2: at.y, text: v });
  }

  // ---- what the person does ----
  function setTool(t) {
    commitNote();
    st.tool = t;
    st.popup = null;
    st.draft = null;
    blob(null);
    drawMarks();
    refresh();
  }
  function openBar() {
    ensure();
    if (st.open) return;
    st.open = true;
    st.tool = 'select';
    refresh();
    // The bar rises in 160 ms; with less motion it is just there.
    if (!reduced() && ui.bar.animate) ui.bar.animate([{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: SPEC.blob.ms, easing: 'ease-out' });
    push({ kind: 'open' });
  }
  function closeBar() {
    commitNote();
    var was = st.open;
    st.open = false;
    st.sending = false;
    st.marks = [];
    st.redo = [];
    st.thumb = '';
    blob(null);
    drawMarks();
    refresh();
    if (was) push({ kind: 'close' });
  }
  function nearOf(m) {
    if (m.near) return m.near;
    var p = probe(m);
    var n = pageNodeAt(p.x, p.y);
    return n ? (isFrame(n) ? { tag: n.tagName.toLowerCase(), selector: one(path(n), 200), text: '', attrs: [] } : describe(n)) : null;
  }
  function startSend() {
    commitNote();
    if (!st.marks.length) return;
    st.sending = true;
    st.popup = null;
    st.thumb = '';
    st.noPicture = false;
    st.taking = true;
    st.marks.forEach(function (m) {
      m.near = nearOf(m);
    });
    refresh();
    var r = { x: 0, y: 0, w: window.innerWidth, h: Math.max(0, window.innerHeight - TOP) };
    push({ kind: 'prepare', marks: wireMarks(), area: r, vw: window.innerWidth, sig: st.marks.map(function (m) { return m.id; }).join(',') });
  }
  function wireMarks() {
    return st.marks.map(function (m) {
      var out = { type: m.type, near: m.near || null };
      if (m.type === 'text') out.text = m.text;
      return out;
    });
  }
  // ---- who gets it: the list of running agents ----
  function openTo() {
    st.toOpen = true;
    typing = true;
    refresh();
    var cur = ui.toList.querySelector('[data-cur="1"]') || ui.toList.querySelector('button:not([disabled])');
    if (cur) cur.focus();
  }
  function closeTo() {
    st.toOpen = false;
    typing = false;
    refresh();
  }
  function logoFor(agent, size) {
    var l = LOGOS[agent];
    if (!l) {
      var m = css(el('span'), 'flex:none;display:grid;place-items:center;width:' + size + 'px;height:' + size + 'px;border-radius:5px;font-size:' + Math.round(size * 0.6) + 'px;font-weight:700;background:' + T.hover + ';color:' + T.text);
      m.textContent = (agent || '?').charAt(0).toUpperCase();
      return m;
    }
    var light = T === THEMES.light;
    var v = svgEl('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', fill: (light ? l.light : l.dark) || 'currentColor' });
    svgEl('path', { d: l.path }, v);
    v.style.flex = 'none';
    return v;
  }
  function targetRow(t, picked) {
    var rest = picked ? T.hover : 'transparent';
    var b = css(el('button'), 'all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:6px 12px;border-radius:8px;cursor:' + (t.ok ? 'pointer' : 'default') + ';opacity:' + (t.ok ? 1 : 0.5) + ';background:' + rest);
    b.setAttribute('type', 'button');
    b.setAttribute('role', 'menuitem');
    if (picked) b.setAttribute('data-cur', '1');
    if (!t.ok) {
      b.disabled = true;
      if (t.reason) b.setAttribute('title', one(t.reason, 160));
    }
    b.appendChild(logoFor(t.agent, 20));
    var col = css(el('span'), 'display:flex;flex-direction:column;min-width:0;flex:1');
    var name = css(el('span'), 'font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
    name.textContent = t.name;
    if (t.task) {
      var task = css(el('span'), 'font-weight:400;color:' + T.dim);
      task.textContent = ' \u00b7 ' + t.task;
      name.appendChild(task);
    }
    var sub = css(el('span'), 'font-size:11.5px;color:' + T.dim + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
    var word = css(el('span'), t.status === 'working' ? 'color:' + T.accent : t.status === 'waiting' ? 'color:' + T.text + ';font-weight:600' : '');
    word.textContent = S[t.status] || S.idle;
    sub.appendChild(doc.createTextNode(t.project ? t.project + ' \u00b7 ' : ''));
    sub.appendChild(word);
    if (t.id === st.ownerId) sub.appendChild(doc.createTextNode(' \u00b7 ' + S.thisPage));
    col.appendChild(name);
    col.appendChild(sub);
    b.appendChild(col);
    if (picked) {
      var tick = svgEl('svg', { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      svgEl('path', { d: 'M4.5 10.5l3.5 3.5 7.5-8' }, tick);
      b.appendChild(css(tick, 'flex:none;color:' + T.dim));
    }
    listen.call(b, 'mouseenter', function () { if (t.ok) b.style.background = T.hover; });
    listen.call(b, 'mouseleave', function () { b.style.background = rest; });
    listen.call(b, 'focus', function () { b.style.background = T.hover; });
    listen.call(b, 'blur', function () { b.style.background = rest; });
    click(b, function () {
      if (!t.ok) return;
      st.to = t.id;
      closeTo();
      doSend();
    });
    return b;
  }
  function renderTo() {
    var pick = st.targets.length > 0;
    var cur = st.targets.find(function (t) { return t.id === st.to && t.ok; }) || st.targets.find(function (t) { return t.ok; }) || null;
    if (cur && st.to !== cur.id) st.to = cur.id;
    // The list is rebuilt only when something it shows changed: a rebuild between a press and its release would drop the click.
    var sig = JSON.stringify([st.targets, st.to, st.toOpen, st.ownerId, T === THEMES.light]);
    if (sig === renderTo.sig) return;
    renderTo.sig = sig;
    var b = ui.toBtn;
    while (b.firstChild) b.removeChild(b.firstChild);
    css(b, 'all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:32px;max-width:60%;padding:0 10px;border-radius:8px;border:1px solid ' + T.line + ';color:' + T.text);
    var lead = css(el('span'), 'color:' + T.dim);
    lead.textContent = S.to;
    b.appendChild(lead);
    if (cur) b.appendChild(logoFor(cur.agent, 16));
    var now = css(el('span'), 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
    now.textContent = cur ? cur.name : pick ? S.toPick : S.noAgents;
    b.appendChild(now);
    b.appendChild(doc.createTextNode('\u25be'));
    b.setAttribute('aria-expanded', st.toOpen ? 'true' : 'false');
    var l = ui.toList;
    while (l.firstChild) l.removeChild(l.firstChild);
    css(l, 'position:absolute;right:8px;bottom:calc(100% + 6px);width:min(340px,calc(100% - 16px));max-height:320px;overflow-y:auto;padding:4px;border-radius:10px;box-sizing:border-box;background:' + T.bar + ';border:1px solid ' + T.line + ';color:' + T.text + ';box-shadow:0 8px 24px rgba(0,0,0,.35);display:' + (st.toOpen ? 'block' : 'none'));
    if (!st.toOpen) return;
    st.targets.forEach(function (t) { l.appendChild(targetRow(t, cur && t.id === cur.id)); });
    var nb = css(el('button'), 'all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:6px 12px;cursor:pointer;border-radius:8px;margin-top:4px;font-size:13px;font-weight:600;' + (pick ? 'border-top:1px solid ' + T.line : ''));
    nb.setAttribute('type', 'button');
    nb.setAttribute('role', 'menuitem');
    var plus = css(el('span'), 'width:20px;text-align:center;font-size:18px;line-height:1;color:' + T.dim);
    plus.textContent = '+';
    nb.appendChild(plus);
    nb.appendChild(doc.createTextNode(pick ? S.newAgent : S.startAgent));
    listen.call(nb, 'focus', function () { nb.style.background = T.hover; });
    listen.call(nb, 'blur', function () { nb.style.background = 'transparent'; });
    click(nb, function () { closeTo(); push({ kind: 'newagent' }); });
    l.appendChild(nb);
  }
  function doSend() {
    var hasNote = st.marks.some(function (m) { return m.type === 'text'; });
    if (!st.request.trim() && !hasNote) {
      st.needText = true;
      refresh();
      return ui.req.focus();
    }
    push({ kind: 'send', request: st.request, marks: wireMarks(), to: st.to });
  }
  function say(text) {
    st.status = text;
    refresh();
    if (say.t) clearT(say.t);
    say.t = setT(function () {
      st.status = '';
      refresh();
    }, 1800);
  }

  // ---- the bar ----
  var BTN = 'all:unset;box-sizing:border-box;cursor:pointer;width:' + SPEC.sizes.button + 'px;height:' + SPEC.sizes.button + 'px;display:grid;place-items:center;border-radius:8px;flex:none;';
  function tbtn(id, iconName, label, key) {
    var b = el('button', BTN);
    b.setAttribute('type', 'button');
    b.setAttribute('aria-label', label);
    b.setAttribute('title', key ? label + ' (' + key + ')' : label);
    b.appendChild(icon(iconName));
    b._icon = iconName;
    ui.btn[id] = b;
    return b;
  }
  function click(node, fn) {
    listen.call(node, 'click', function (e) {
      if (!e.isTrusted) return;
      e.stopPropagation();
      fn();
    });
  }
  function build() {
    host = create.call(doc, 'div');
    host.setAttribute('aria-hidden', 'true');
    css(host, 'all:initial;position:fixed;left:0;right:0;bottom:0;top:' + TOP + 'px;z-index:2147483647;pointer-events:none;display:none');
    var root = host.attachShadow({ mode: 'closed' });
    ui = { btn: {} };
    var layer = css(el('div'), 'position:absolute;inset:0;overflow:hidden;pointer-events:none');
    ui.ink = svgEl('svg', {});
    css(ui.ink, 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;touch-action:none');
    listen.call(ui.ink, 'pointerdown', down);
    listen.call(ui.ink, 'pointermove', move);
    listen.call(ui.ink, 'pointerup', up);
    listen.call(ui.ink, 'pointercancel', function () {
      live = null;
      st.draft = null;
      drawMarks();
    });
    layer.appendChild(ui.ink);
    ui.blob = css(el('div'), 'position:absolute;left:0;top:0;width:0;height:0;box-sizing:border-box;border:2px solid ' + T.accent + ';background:' + T.accentSoft + ';border-radius:4px;opacity:0;pointer-events:none');
    ui.blobLabel = css(el('i'), 'position:absolute;left:-2px;top:-21px;padding:0 5px;border-radius:3px;background:' + T.accent + ';color:' + T.accentFg + ';font:11px/17px ui-monospace,Consolas,monospace;font-style:normal;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis');
    ui.blob.appendChild(ui.blobLabel);
    layer.appendChild(ui.blob);
    ui.note = el('input', 'display:none');
    ui.note.setAttribute('type', 'text');
    ui.note.setAttribute('maxlength', String(SPEC.sizes.noteMax));
    ui.note.setAttribute('placeholder', S.notePlaceholder);
    ui.note.setAttribute('aria-label', S.noteLabel);
    listen.call(ui.note, 'focus', function () { typing = true; });
    listen.call(ui.note, 'blur', function () { typing = false; commitNote(); });
    listen.call(ui.note, 'keydown', function (e) {
      if (e.isComposing) return;
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commitNote();
      } else if (e.key === 'Escape') {
        note = null;
        ui.note.value = '';
        ui.note.style.display = 'none';
      }
    });
    layer.appendChild(ui.note);
    root.appendChild(layer);

    var dock = css(el('div'), 'position:absolute;left:0;right:0;bottom:16px;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;font:13px/18px system-ui,Segoe UI,sans-serif');
    ui.dock = dock;
    ui.status = css(el('div'), 'display:none;padding:3px 9px;border-radius:8px;font-size:12px;pointer-events:auto');
    ui.status.setAttribute('role', 'status');
    dock.appendChild(ui.status);

    // the send row
    ui.row = css(el('div'), 'display:none;gap:8px;width:min(520px,calc(100% - 32px));padding:8px;border-radius:12px;pointer-events:auto;box-sizing:border-box;position:relative');
    ui.thumb = css(el('img'), 'flex:none;align-self:center;width:92px;max-height:80px;object-fit:contain;border-radius:6px');
    ui.thumbNone = css(el('div'), 'flex:none;align-self:center;width:92px;min-height:52px;display:grid;place-items:center;text-align:center;font-size:11px;border-radius:6px;padding:4px;box-sizing:border-box');
    var col = css(el('div'), 'flex:1;display:flex;flex-direction:column;gap:5px;min-width:0');
    ui.req = css(el('input'), 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;background:transparent;font:inherit;outline:none');
    ui.req.setAttribute('type', 'text');
    ui.req.setAttribute('maxlength', '2000');
    ui.req.setAttribute('aria-label', S.request);
    listen.call(ui.req, 'focus', function () { typing = true; });
    listen.call(ui.req, 'blur', function () { typing = false; });
    listen.call(ui.req, 'input', function () {
      st.request = ui.req.value;
      st.needText = false;
    });
    listen.call(ui.req, 'keydown', function (e) {
      if (e.isComposing) return;
      e.stopPropagation();
      if (e.key === 'Enter' && e.isTrusted) {
        e.preventDefault();
        doSend();
      } else if (e.key === 'Escape') {
        st.sending = false;
        refresh();
      }
    });
    var meta = css(el('div'), 'display:flex;align-items:center;gap:8px;font-size:12px');
    ui.count = el('span');
    ui.toBtn = css(el('button'), '');
    ui.toBtn.setAttribute('type', 'button');
    ui.toBtn.setAttribute('aria-haspopup', 'menu');
    ui.toBtn.setAttribute('aria-label', S.toPick);
    click(ui.toBtn, function () { st.toOpen ? closeTo() : openTo(); });
    ui.toList = css(el('div'), 'display:none');
    ui.toList.setAttribute('role', 'menu');
    ui.toList.setAttribute('aria-label', S.toPick);
    listen.call(ui.toList, 'keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTo();
        return ui.toBtn.focus();
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var items = [].slice.call(ui.toList.querySelectorAll('button:not([disabled])'));
      if (!items.length) return;
      e.preventDefault();
      var at = items.indexOf(root.activeElement);
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });
    ui.go = css(el('button'), 'all:unset;cursor:pointer;height:' + SPEC.sizes.button + 'px;padding:0 12px;box-sizing:border-box;border-radius:8px;font-weight:600;white-space:nowrap;line-height:' + SPEC.sizes.button + 'px');
    ui.go.textContent = S.send;
    click(ui.go, doSend);
    meta.appendChild(ui.count);
    meta.appendChild(css(el('span'), 'flex:1'));
    meta.appendChild(ui.toBtn);
    meta.appendChild(ui.go);
    col.appendChild(ui.req);
    col.appendChild(meta);
    ui.row.appendChild(ui.thumb);
    ui.row.appendChild(ui.thumbNone);
    ui.row.appendChild(col);
    ui.row.appendChild(ui.toList);
    dock.appendChild(ui.row);

    // the bar
    ui.bar = css(el('div'), 'position:relative;display:flex;align-items:center;gap:2px;padding:4px;border-radius:' + SPEC.sizes.radius + 'px;pointer-events:auto;box-sizing:border-box;max-width:calc(100% - 16px)');
    ui.bar.setAttribute('role', 'toolbar');
    ui.bar.setAttribute('aria-label', S.bar);
    var bar = ui.bar;
    bar.appendChild(tbtn('select', 'select', S.select, 'V'));
    bar.appendChild(tbtn('pen', 'pen', S.pen, 'P'));
    bar.appendChild(tbtn('shape', 'rect', S.shape, 'R A O'));
    ui.caret = tbtn('caret', 'caret', S.moreShapes);
    css(ui.caret, BTN + 'width:14px;margin-left:-4px');
    bar.appendChild(ui.caret);
    bar.appendChild(tbtn('text', 'text', S.text, 'T'));
    ui.colour = el('button', BTN);
    ui.colour.setAttribute('type', 'button');
    ui.colour.setAttribute('aria-label', S.colour);
    ui.colour.setAttribute('title', S.colour);
    ui.dot = css(el('span'), 'display:block;width:14px;height:14px;border-radius:50%');
    ui.colour.appendChild(ui.dot);
    bar.appendChild(ui.colour);
    ui.sep1 = css(el('span'), 'flex:none;width:1px;height:18px;margin:0 4px');
    bar.appendChild(ui.sep1);
    bar.appendChild(tbtn('undo', 'undo', S.undo, 'Ctrl+Z'));
    bar.appendChild(tbtn('clear', 'clear', S.clear));
    bar.appendChild(tbtn('more', 'more', S.more));
    ui.sep2 = css(el('span'), 'flex:none;width:1px;height:18px;margin:0 4px');
    bar.appendChild(ui.sep2);
    ui.send = css(el('button'), 'all:unset;cursor:pointer;height:' + SPEC.sizes.button + 'px;padding:0 12px;box-sizing:border-box;border-radius:8px;font-weight:600;white-space:nowrap;line-height:' + SPEC.sizes.button + 'px;flex:none');
    ui.send.setAttribute('type', 'button');
    ui.send.setAttribute('title', S.send + ' (Ctrl+Enter)');
    bar.appendChild(ui.send);
    bar.appendChild(tbtn('close', 'close', S.close, 'Esc'));
    ui.pop = css(el('div'), 'display:none;position:absolute;bottom:42px;padding:4px;border-radius:10px;gap:2px');
    bar.appendChild(ui.pop);
    dock.appendChild(bar);
    root.appendChild(dock);

    click(ui.btn.select, function () { setTool('select'); });
    click(ui.btn.pen, function () { setTool('pen'); });
    click(ui.btn.shape, function () { setTool('shape'); });
    click(ui.btn.text, function () { setTool('text'); });
    click(ui.caret, function () { togglePop('shapes'); });
    click(ui.colour, function () { togglePop('colors'); });
    click(ui.btn.undo, undo);
    click(ui.btn.clear, function () { clearMarks(false); });
    click(ui.btn.more, function () { togglePop('more'); });
    click(ui.send, startSend);
    click(ui.btn.close, closeBar);
  }
  function togglePop(name) {
    st.popup = st.popup === name ? null : name;
    refresh();
  }
  function popItem(label, iconName, fn, key) {
    var b = css(el('button'), 'all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;white-space:nowrap');
    b.setAttribute('type', 'button');
    if (iconName) b.appendChild(icon(iconName, 16));
    b.appendChild(el('span', '', label));
    if (key) b.appendChild(css(el('span', '', key), 'margin-left:auto;font:11px ui-monospace,Consolas,monospace;opacity:.7'));
    click(b, fn);
    return b;
  }
  function renderPop() {
    var p = ui.pop;
    while (p.firstChild) p.removeChild(p.firstChild);
    p.setAttribute('role', 'menu');
    css(p, 'position:absolute;bottom:42px;padding:4px;border-radius:10px;gap:2px;background:' + T.bar + ';border:1px solid ' + T.line + ';color:' + T.text + ';box-shadow:0 8px 24px rgba(0,0,0,.35);' + (st.popup ? 'display:flex;' : 'display:none;') + (st.popup === 'shapes' || st.popup === 'more' ? 'flex-direction:column;min-width:150px;' : '') + (st.popup === 'more' ? 'right:4px;' : st.popup === 'colors' ? 'left:120px;' : 'left:70px;'));
    if (st.popup === 'shapes') {
      SPEC.shapes.forEach(function (s) {
        p.appendChild(popItem(S[s.id], s.id, function () {
          st.shape = s.id;
          setTool('shape');
        }, s.key.toUpperCase()));
      });
    } else if (st.popup === 'colors') {
      SPEC.colors.forEach(function (c) {
        var b = css(el('button'), 'all:unset;cursor:pointer;width:26px;height:26px;display:grid;place-items:center;border-radius:7px');
        b.setAttribute('type', 'button');
        b.setAttribute('aria-label', S[c.id]);
        b.appendChild(css(el('span'), 'display:block;width:14px;height:14px;border-radius:50%;background:' + c.value));
        click(b, function () {
          st.color = c.value;
          st.popup = null;
          refresh();
        });
        p.appendChild(b);
      });
    } else if (st.popup === 'more') {
      p.appendChild(popItem(S.undo, 'undo', function () { st.popup = null; undo(); }, 'Ctrl+Z'));
      p.appendChild(popItem(S.clear, 'clear', function () { st.popup = null; clearMarks(false); }));
    }
  }
  function refresh() {
    if (!ui) return;
    host.style.display = st.open ? 'block' : 'none';
    var n = st.marks.length;
    var fold = st.width > 0 && st.width < SPEC.narrow.foldUndoClear;
    var iconSend = st.width > 0 && st.width < SPEC.narrow.sendAsIcon;
    css(ui.bar, 'position:relative;display:flex;align-items:center;gap:2px;padding:4px;border-radius:' + SPEC.sizes.radius + 'px;pointer-events:auto;box-sizing:border-box;max-width:calc(100% - 16px);background:' + T.bar + ';border:1px solid ' + T.line + ';color:' + T.text + ';box-shadow:0 8px 24px rgba(0,0,0,.35)');
    ['select', 'pen', 'shape', 'text'].forEach(function (id) {
      var b = ui.btn[id];
      var on = st.tool === id;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      css(b, BTN + 'color:' + (on ? T.accent : T.dim) + ';background:' + (on ? T.accentSoft : 'transparent'));
    });
    // The shape button shows the last shape.
    var sb = ui.btn.shape;
    if (sb._icon !== st.shape) {
      sb.removeChild(sb.firstChild);
      sb.appendChild(icon(st.shape));
      sb._icon = st.shape;
    }
    css(ui.caret, BTN + 'width:14px;margin-left:-4px;color:' + T.dim);
    css(ui.btn.close, BTN + 'color:' + T.dim);
    ['undo', 'clear'].forEach(function (id) {
      var b = ui.btn[id];
      b.disabled = !n;
      css(b, BTN + 'color:' + T.dim + ';opacity:' + (n ? 1 : 0.35) + ';display:' + (fold ? 'none' : 'grid'));
    });
    css(ui.btn.more, BTN + 'color:' + T.dim + ';display:' + (fold ? 'grid' : 'none'));
    css(ui.colour, BTN + 'color:' + T.dim);
    css(ui.dot, 'display:block;width:14px;height:14px;border-radius:50%;background:' + st.color + ';border:2px solid ' + T.bar + ';box-shadow:0 0 0 1px ' + T.line);
    css(ui.sep1, 'flex:none;width:1px;height:18px;margin:0 4px;background:' + T.line);
    css(ui.sep2, 'flex:none;width:1px;height:18px;margin:0 4px;background:' + T.line);
    ui.send.disabled = !n;
    ui.send.setAttribute('aria-label', S.send);
    ui.send.textContent = iconSend ? '➤' : n ? S.sendCount.replace('{n}', String(n)) : S.sendToChat;
    css(ui.send, 'all:unset;cursor:pointer;height:' + SPEC.sizes.button + 'px;padding:0 ' + (iconSend ? 9 : 12) + 'px;box-sizing:border-box;border-radius:8px;font-weight:600;white-space:nowrap;line-height:' + SPEC.sizes.button + 'px;flex:none;background:' + T.accent + ';color:' + T.accentFg + ';opacity:' + (n ? 1 : 0.4));
    // Layer: takes the mouse only for a draw tool.
    css(ui.ink, 'position:absolute;left:0;top:0;width:100%;height:100%;touch-action:none;pointer-events:' + (takesMouse() ? 'all' : 'none') + ';cursor:' + (st.tool === 'text' ? 'text' : 'crosshair'));
    // Status line.
    ui.status.style.display = st.status ? 'block' : 'none';
    ui.status.textContent = st.status;
    css(ui.status, 'padding:3px 9px;border-radius:8px;font-size:12px;pointer-events:auto;background:' + T.bar + ';border:1px solid ' + T.line + ';color:' + T.dim + (st.status ? '' : ';display:none'));
    // Send row.
    var showRow = st.sending && n > 0;
    css(ui.row, 'display:' + (showRow ? 'flex' : 'none') + ';gap:8px;width:min(520px,calc(100% - 32px));padding:8px;border-radius:12px;pointer-events:auto;box-sizing:border-box;position:relative;background:' + T.bar + ';border:1px solid ' + T.line + ';color:' + T.text + ';box-shadow:0 8px 24px rgba(0,0,0,.35)');
    if (showRow) {
      if (st.thumb) {
        ui.thumb.setAttribute('src', st.thumb);
        ui.thumb.setAttribute('alt', S.shotOf);
        ui.thumb.style.display = 'block';
        ui.thumbNone.style.display = 'none';
      } else {
        ui.thumb.style.display = 'none';
        ui.thumbNone.style.display = 'grid';
        ui.thumbNone.textContent = st.taking ? S.taking : st.noPicture ? S.noPicture : '';
        css(ui.thumbNone, 'flex:none;align-self:center;width:92px;min-height:52px;display:grid;place-items:center;text-align:center;font-size:11px;border-radius:6px;padding:4px;box-sizing:border-box;border:1px solid ' + T.line + ';color:' + T.dim);
      }
      css(ui.req, 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;background:transparent;font:inherit;outline:none;color:' + T.text + ';border:1px solid ' + (st.needText ? T.accent : T.line));
      ui.req.setAttribute('placeholder', st.needText ? S.requestNeeded : S.request);
      var els = 0;
      st.marks.forEach(function (m) { if (m.type === 'pick') els++; });
      ui.count.textContent = (n === 1 ? S.count1 : S.countN.replace('{n}', String(n))) + (els ? ' · ' + (els === 1 ? S.element1 : S.elementsN.replace('{n}', String(els))) : '');
      css(ui.count, 'color:' + T.dim);
      // Who gets it: a running agent, the page's own first.
      renderTo();
      ui.go.disabled = st.taking || !st.targets.some(function (t) { return t.ok; });
      css(ui.go, 'all:unset;cursor:pointer;height:' + SPEC.sizes.button + 'px;padding:0 12px;box-sizing:border-box;border-radius:8px;font-weight:600;white-space:nowrap;line-height:' + SPEC.sizes.button + 'px;background:' + T.accent + ';color:' + T.accentFg + ';opacity:' + (st.taking ? 0.4 : 1));
    }
    renderPop();
    ui.blob.style.borderColor = T.accent;
    ui.blob.style.background = T.accentSoft;
    ui.blobLabel.style.background = T.accent;
    ui.blobLabel.style.color = T.accentFg;
  }
  function ensure() {
    if (host && host.isConnected) return;
    var parent = doc.documentElement || doc.body;
    if (!parent) return;
    if (!ui) build();
    parent.appendChild(host);
    refresh();
  }
  // Re-assert on fullscreen changes: the bar stays above the page.
  listen.call(doc, 'fullscreenchange', function () {
    if (host && host.isConnected) {
      try {
        (doc.fullscreenElement || doc.documentElement).appendChild(host);
      } catch (e) {}
    }
  });
  // The page cannot see the mouse while the bar is open; the keys, the wheel and the clicks are ours.
  listen.call(doc, 'mousemove', onMove, true);
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu', 'submit'].forEach(function (n) {
    listen.call(doc, n, stopPage, true);
  });
  listen.call(doc, 'click', onClickCapture, true);
  listen.call(window, 'wheel', holdScroll, { passive: false, capture: true });
  listen.call(window, 'touchmove', holdScroll, { passive: false, capture: true });
  listen.call(window, 'keydown', function (e) {
    if (st.open && st.marks.length && e.isTrusted && [' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].indexOf(e.key) >= 0 && !typing) e.preventDefault();
  }, true);
  listen.call(window, 'keydown', onKey, true);
  listen.call(window, 'resize', function () {
    st.width = window.innerWidth;
    if (st.open && st.marks.length) {
      clearMarks(true);
      say(S.resized);
    } else refresh();
  });
  st.width = window.innerWidth;

  // ---- the API Rust uses (frozen, under a name the page does not know) ----
  var api = {
    // Rust pushes: { theme, less, thumb, taking, noPicture, targets, to, owner, status }
    set: function (json) {
      try {
        var v = parse(json);
        if (v.theme && THEMES[v.theme]) T = THEMES[v.theme];
        if (typeof v.less === 'boolean') less = v.less;
        if ('thumb' in v) st.thumb = String(v.thumb || '');
        if ('taking' in v) st.taking = !!v.taking;
        if ('noPicture' in v) st.noPicture = !!v.noPicture;
        if (v.targets) st.targets = v.targets.slice(0, 40);
        if ('to' in v) st.to = String(v.to || '');
        if ('ownerId' in v) st.ownerId = String(v.ownerId || '');
        if ('owner' in v) st.owner = one(v.owner, 60);
        if (v.status) say(one(v.status, 160));
        if (v.sent) {
          clearMarks(true);
          st.request = '';
          if (ui) ui.req.value = '';
          say(one(v.status || S.sent, 160));
        }
        if (v.open === true) openBar();
        if (v.open === false) closeBar();
        ensure();
        refresh();
      } catch (e) {}
    },
    // Rust hides the bar (not the marks) and blanks password, card and code boxes just before the picture, and undoes it after.
    shoot: function (on) {
      ensure();
      if (!ui) return;
      ui.dock.style.visibility = on ? 'hidden' : 'visible';
      ui.blob.style.visibility = on ? 'hidden' : 'visible';
      var secret = doc.querySelectorAll('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="cvv" i],input[name*="card" i]');
      for (var i = 0; i < secret.length; i++) {
        var n = secret[i];
        if (on) {
          n.setAttribute('data-pm-shield', n.style.visibility || '-');
          n.style.setProperty('visibility', 'hidden', 'important');
        } else if (n.hasAttribute('data-pm-shield')) {
          var was = n.getAttribute('data-pm-shield');
          n.removeAttribute('data-pm-shield');
          if (was === '-') n.style.removeProperty('visibility');
          else n.style.visibility = was;
        }
      }
      return null;
    },
    take: function () {
      if (!queue.length) return null;
      return stringify(queue.splice(0, queue.length));
    },
    // For tests and for Rust's "is it open" check.
    state: function () {
      return stringify({ open: st.open, marks: st.marks.length, sending: st.sending });
    },
  };
  try {
    Object.defineProperty(window, KEY, { value: Object.freeze(api), enumerable: false, configurable: false, writable: false });
  } catch (e) {
    return;
  }
})();
