// One page that draws any moment of the tour. window.__seek(seconds) is all a renderer needs; with #autoplay it plays
// by itself (the slideshow). Text is always set with textContent, never as HTML.
(function () {
  var SPEC = JSON.parse(document.getElementById('spec').textContent);
  var hash = location.hash || '';
  var autoplay = /autoplay/.test(hash) || document.body.hasAttribute('data-autoplay');
  var vertical = /vertical/.test(hash) || (autoplay && innerHeight > innerWidth);
  var L = vertical ? SPEC.layouts.vertical : SPEC.layouts.landscape;
  var W = L.width, H = L.height;
  var beats = SPEC.beats, starts = [], total = 0;
  beats.forEach(function (b) { starts.push(total); total += b.seconds; });

  var root = document.getElementById('root');
  root.style.width = W + 'px'; root.style.height = H + 'px';
  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function place(e, r) { e.style.left = r.x + 'px'; e.style.top = r.y + 'px'; e.style.width = r.w + 'px'; e.style.height = r.h + 'px'; }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function ease(x) { return 1 - Math.pow(1 - clamp01(x), 3); }
  function mix(a, b, t) {
    var pa = [1, 3, 5].map(function (i) { return parseInt(a.substr(i, 2), 16); });
    var pb = [1, 3, 5].map(function (i) { return parseInt(b.substr(i, 2), 16); });
    return 'rgb(' + pa.map(function (v, i) { return Math.round(v + (pb[i] - v) * t); }).join(',') + ')';
  }

  var bar = el('div', null, root); bar.id = 'bar';
  var lt = el('div', 'layer centre', root); place(lt, { x: 0, y: 0, w: W, h: L.caption.y });
  var ltH = el('h1', null, lt), ltS = el('p', 'sub', lt); el('div', 'dot', lt);
  var lc = el('div', 'layer', root);
  var cb = el('div', 'cardbox abs', lc); place(cb, L.card);
  var cbH = el('h2', null, cb), cbP = el('p', 'body', cb);
  var lf = el('div', 'layer', root);
  var fb = el('div', 'cardbox abs', lf); place(fb, L.card);
  var fbH = el('h2', null, fb), fbU = el('ul', null, fb);
  var lo = el('div', 'layer centre', root); place(lo, { x: 0, y: 0, w: W, h: L.caption.y });
  var loH = el('h1', null, lo); el('div', 'dot', lo);
  var ld = el('div', 'layer', root);
  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('class', 'edges'); svg.setAttribute('width', W); svg.setAttribute('height', H); ld.appendChild(svg);
  var edgeEls = L.edges.map(function (e) {
    var base = document.createElementNS(svgNS, 'line'), hot = document.createElementNS(svgNS, 'line'), head = document.createElementNS(svgNS, 'polygon');
    [base, hot].forEach(function (l) { l.setAttribute('x1', e.x1); l.setAttribute('y1', e.y1); l.setAttribute('x2', e.x2); l.setAttribute('y2', e.y2); l.setAttribute('stroke-linecap', 'round'); svg.appendChild(l); });
    base.setAttribute('stroke', '#3b4049'); base.setAttribute('stroke-width', '3');
    hot.setAttribute('stroke', '#e8762b'); hot.setAttribute('stroke-width', '6');
    var len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1, ux = (e.x2 - e.x1) / len, uy = (e.y2 - e.y1) / len;
    head.setAttribute('points', [[e.x2, e.y2], [e.x2 - ux * 26 - uy * 12, e.y2 - uy * 26 + ux * 12], [e.x2 - ux * 26 + uy * 12, e.y2 - uy * 26 - ux * 12]].map(function (p) { return p.join(','); }).join(' '));
    head.setAttribute('fill', '#e8762b'); svg.appendChild(head);
    return { e: e, base: base, hot: hot, head: head, len: len };
  });
  var nodeEls = L.nodes.map(function (n) { var d = el('div', 'node', ld, n.label); place(d, n.rect); return { n: n, d: d }; });
  var cap = el('div', null, root); cap.id = 'caption'; place(cap, L.caption);
  var capT = el('span', null, cap);
  var capSize = vertical ? 50 : 44;
  var hint = null;
  if (autoplay) { hint = el('div', null, root, 'Click to pause'); hint.id = 'hint'; }

  var layers = { title: lt, card: lc, files: lf, outro: lo, diagram: ld };
  var shown = -1;
  function fit(node, box, start, min) {
    var s = start; node.style.fontSize = s + 'px';
    while (s > min && node.scrollHeight > box + 1) { s -= 2; node.style.fontSize = s + 'px'; }
  }
  function setBeat(i) {
    if (shown === i) return;
    shown = i;
    var b = beats[i], s = b.shot;
    capT.textContent = b.caption;
    var size = capSize; cap.style.fontSize = size + 'px';
    while (size > 24 && capT.offsetHeight > L.caption.h - 36) { size -= 2; cap.style.fontSize = size + 'px'; }
    if (s.kind === 'title') { ltH.textContent = s.title; ltS.textContent = s.subtitle; fit(ltH, H * 0.4, vertical ? 92 : 112, 40); }
    if (s.kind === 'card') {
      cbH.textContent = s.title; cbP.textContent = s.text; cbP.style.display = s.text ? '' : 'none';
      fit(cbH, L.card.h * 0.45, s.text ? 80 : 104, 36); fit(cbP, L.card.h * 0.5, 46, 26);
    }
    if (s.kind === 'files') { fbH.textContent = s.title; while (fbU.firstChild) fbU.removeChild(fbU.firstChild); s.paths.forEach(function (p) { el('li', null, fbU, p); }); }
    if (s.kind === 'outro') { loH.textContent = s.text; fit(loH, H * 0.4, vertical ? 92 : 112, 40); }
  }
  function seek(t) {
    t = Math.max(0, Math.min(total - 0.001, t));
    var i = starts.length - 1;
    for (var k = 0; k < starts.length; k++) { if (t < starts[k] + beats[k].seconds) { i = k; break; } }
    var b = beats[i], local = t - starts[i], dur = b.seconds, name = b.shot.kind;
    setBeat(i);
    var prev = i > 0 ? beats[i - 1].shot.kind : null, next = i + 1 < beats.length ? beats[i + 1].shot.kind : null;
    Object.keys(layers).forEach(function (k) {
      var o = 0;
      if (k === name) {
        var inn = prev === k ? 1 : clamp01(local / 0.35);
        var out = next && next !== k ? clamp01((dur - local) / 0.25) : 1;
        o = Math.min(inn, out);
      }
      layers[k].style.opacity = o;
    });
    var slide = (1 - ease(local / 0.45)) * 22;
    capT.style.opacity = ease(local / 0.35); capT.style.transform = 'translateY(' + slide + 'px)';
    cb.style.transform = 'translateY(' + slide + 'px)'; fb.style.transform = 'translateY(' + slide + 'px)';
    if (name === 'diagram') {
      var lit = b.shot.lit, edges = b.shot.edges, p = ease(local / 0.6), focus = lit.length > 0;
      nodeEls.forEach(function (x) {
        var on = lit.indexOf(x.n.id) >= 0, a = on ? p : 0;
        x.d.style.borderColor = mix('#3b4049', '#e8762b', a);
        x.d.style.background = mix('#1f2228', '#3a2a20', a);
        x.d.style.opacity = focus && !on ? 0.42 : 1;
      });
      edgeEls.forEach(function (x) {
        var on = edges.some(function (q) { return q[0] === x.e.from && q[1] === x.e.to; });
        var pr = on ? ease((local - 0.15) / 0.8) : 0;
        x.hot.setAttribute('stroke-dasharray', x.len); x.hot.setAttribute('stroke-dashoffset', x.len * (1 - pr));
        x.hot.style.opacity = pr > 0 ? 1 : 0; x.head.style.opacity = pr > 0.97 ? 1 : 0;
        x.base.style.opacity = focus && !on ? 0.4 : 1;
      });
    }
    bar.style.transform = 'scaleX(' + (t / total) + ')';
    return true;
  }
  function resize() {
    var s = Math.min(innerWidth / W, innerHeight / H);
    root.style.transform = 'translate(' + ((innerWidth - W * s) / 2) + 'px,' + ((innerHeight - H * s) / 2) + 'px) scale(' + s + ')';
  }
  addEventListener('resize', resize); resize();
  window.__design = { w: W, h: H };
  window.__duration = total;
  window.__seek = seek;
  seek(0);
  window.__ready = true;
  if (autoplay) {
    var playing = true, t0 = performance.now(), base = 0;
    addEventListener('click', function () {
      if (playing) { base += (performance.now() - t0) / 1000; playing = false; hint.textContent = 'Click to play'; }
      else { if (base >= total - 0.05) base = 0; t0 = performance.now(); playing = true; hint.textContent = 'Click to pause'; }
    });
    (function tick() {
      if (playing) {
        var t = base + (performance.now() - t0) / 1000;
        if (t >= total) { base = total; playing = false; hint.textContent = 'Click to play again'; seek(total); }
        else seek(t);
      }
      requestAnimationFrame(tick);
    })();
  }
})();
