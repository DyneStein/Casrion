// casrion.com. The page keeps notes on itself, the same way the app does.
// No dependencies, no build step.
(function () {
  'use strict';

  var reading   = document.getElementById('reading');
  var entriesEl = document.getElementById('entries');
  var pageEl    = document.getElementById('page');
  var hintEl    = document.getElementById('hint');
  var countEl   = document.getElementById('count');
  var tagEl     = document.getElementById('tag');
  var tagKeyEl  = document.getElementById('tag-key');
  var saveBtn   = document.getElementById('save');
  var clearBtn  = document.getElementById('clear');
  var srcBox    = document.getElementById('src-on');
  var railEl    = document.querySelector('.rail');
  var drawerTab = document.getElementById('drawer-tab');
  var drawerLbl = document.getElementById('drawer-label');
  var toastEl   = document.getElementById('toast');

  var isMac   = /Mac|iPhone|iPad/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var narrow  = function () { return window.matchMedia('(max-width: 63rem)').matches; };

  var entries = [];
  var nextId  = 1;
  var demoDone = false;

  /* ── Mac key labels ─────────────────────────────── */
  /* Keys are rendered as one keycap each, so this relabels the caps in place.
     Rewriting the textContent of the whole combination, which is what this
     used to do, would flatten the caps back into a string. */
  if (isMac) {
    document.querySelectorAll('.cap').forEach(function (el) {
      if (el.textContent.trim() === 'Ctrl') el.textContent = 'Cmd';
    });
    document.querySelectorAll('.tag-key').forEach(function (el) {
      el.textContent = el.textContent.replace(/Ctrl/g, 'Cmd');
    });
    var note = document.getElementById('mac-keynote');
    if (note) note.hidden = false;
  }

  /* ── Little helpers ─────────────────────────────── */
  function stamp() {
    var d = new Date();
    var h = d.getHours();
    var ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    var m = String(d.getMinutes()).padStart(2, '0');
    return 'casrion.com · ' + h + ':' + m + ' ' + ampm;
  }

  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 1900);
  }

  /* ── Marking the page ───────────────────────────── */
  // Wrap every text node the range touches in its own <mark>, so a selection
  // that crosses element boundaries does not have to be surgically rebuilt.
  function wrapRange(range, id) {
    var root = range.commonAncestorContainer;
    var nodes = [];

    if (root.nodeType === 3) {
      nodes.push(root);
    } else {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        if (range.intersectsNode(n)) nodes.push(n);
      }
    }

    // Read every offset before touching the DOM, because splitting text nodes
    // moves the live range out from under us.
    var plan = nodes.map(function (node) {
      return {
        node:  node,
        start: node === range.startContainer ? range.startOffset : 0,
        end:   node === range.endContainer   ? range.endOffset   : node.length
      };
    });

    var marks = [];
    plan.forEach(function (p) {
      if (p.end <= p.start) return;
      if (!p.node.data.slice(p.start, p.end).trim()) return;
      var target = p.node;
      if (p.end < target.length) target.splitText(p.end);
      if (p.start > 0) target = target.splitText(p.start);
      var m = document.createElement('mark');
      m.className = 'kept';
      m.setAttribute('data-kept', id);
      target.parentNode.insertBefore(m, target);
      m.appendChild(target);
      marks.push(m);
    });

    // let the stroke draw itself, then drop the class so undo and reflow are
    // dealing with a plain mark again
    if (!reduced && marks.length) {
      marks.forEach(function (m) { m.classList.add('drawing'); });
      setTimeout(function () {
        marks.forEach(function (m) { m.classList.remove('drawing'); });
      }, 560);
    }
  }

  function unwrap(id) {
    document.querySelectorAll('mark[data-kept="' + id + '"]').forEach(function (m) {
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
  }

  /* ── The notebook ───────────────────────────────── */
  var KINDS = {
    note:   { cls: 'e-note',   md: function (t) { return [t]; } },
    h1:     { cls: 'e-h1',     md: function (t) { return ['# ' + t]; } },
    h2:     { cls: 'e-h2',     md: function (t) { return ['## ' + t]; } },
    h3:     { cls: 'e-h3',     md: function (t) { return ['### ' + t]; } },
    code:   { cls: 'e-code',   md: function (t) { return ['```', t, '```']; } },
    bold:   { cls: 'e-bold',   md: function (t) { return ['**' + t + '**']; } },
    italic: { cls: 'e-italic', md: function (t) { return ['*' + t + '*']; } }
  };

  function buildEntry(entry) {
    var el = document.createElement(entry.kind === 'code' ? 'pre' : 'p');
    el.className = 'e ' + KINDS[entry.kind].cls;
    el.setAttribute('data-id', entry.id);

    var body = document.createElement('span');
    body.className = 'e-body';
    body.textContent = entry.text;
    el.appendChild(body);

    var src = document.createElement('span');
    src.className = 'e-src';
    src.textContent = 'Source: ' + entry.src;
    src.hidden = !srcBox.checked;
    el.appendChild(src);

    return el;
  }

  function refreshChrome() {
    var n = entries.length;
    countEl.textContent = n === 0 ? 'empty' : n + ' kept';
    hintEl.hidden = n > 0;
    pageEl.classList.toggle('is-empty', n === 0);
    saveBtn.disabled = n === 0;
    clearBtn.disabled = n === 0;
    if (drawerLbl) drawerLbl.textContent = n === 0 ? 'Casrion.md' : 'Casrion.md · ' + n;
    drawerTab.classList.toggle('has', n > 0);
  }

  function addEntry(entry, opts) {
    entries.push(entry);
    var el = buildEntry(entry);
    if (!reduced) el.classList.add('entry-in');
    entriesEl.appendChild(el);
    refreshChrome();
    pageEl.scrollTop = pageEl.scrollHeight;
    if (opts && opts.type) typeOut(el.querySelector('.e-body'), entry.text);
    return el;
  }

  function typeOut(el, text) {
    if (reduced) return;
    el.textContent = '';
    var i = 0;
    (function tick() {
      el.textContent = text.slice(0, i);
      pageEl.scrollTop = pageEl.scrollHeight;
      if (i < text.length) { i += 1; setTimeout(tick, 16); }
    })();
  }

  function undoLast() {
    if (!entries.length) return;
    var gone = entries.pop();
    unwrap(gone.id);
    var el = entriesEl.querySelector('[data-id="' + gone.id + '"]');
    if (el) el.remove();
    refreshChrome();
    toast('took the last one back');
  }

  function clearAll() {
    entries.slice().forEach(function (e) { unwrap(e.id); });
    entries = [];
    entriesEl.textContent = '';
    refreshChrome();
  }

  /* ── The flight from page to notebook ───────────── */
  function fly(rect, text) {
    if (reduced) return;
    var target = (narrow() && !railEl.classList.contains('open'))
      ? drawerTab.getBoundingClientRect()
      : pageEl.getBoundingClientRect();

    var el = document.createElement('div');
    el.className = 'fly';
    el.textContent = text;
    el.style.left = rect.left + 'px';
    el.style.top  = rect.top + 'px';
    document.body.appendChild(el);

    var dx = (target.left + Math.min(target.width, 160) / 2) - rect.left;
    var dy = (target.top + 24) - rect.top;

    requestAnimationFrame(function () {
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(0.62)';
      el.style.opacity = '0';
    });
    setTimeout(function () { el.remove(); }, 460);
  }

  /* ── Capture ────────────────────────────────────── */
  function capture(kind, range, text, opts) {
    if (!KINDS[kind]) kind = 'note';
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;

    var id = nextId++;
    var rect = range.getBoundingClientRect();

    wrapRange(range, id);
    fly(rect, text);
    addEntry({ id: id, kind: kind, text: text, src: stamp() }, opts);

    if (narrow() && !railEl.classList.contains('open')) {
      drawerTab.animate
        ? drawerTab.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
            { duration: 260, easing: 'ease-out' }
          )
        : null;
    }

    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    hideTag();
  }

  /* ── The floating tag ───────────────────────────── */
  var liveRange = null;

  function hideTag() {
    tagEl.hidden = true;
    liveRange = null;
  }

  function currentSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    if (!reading.contains(range.commonAncestorContainer)) return null;
    var text = sel.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 2) return null;
    return { range: range, text: text };
  }

  function showTag() {
    var hit = currentSelection();
    if (!hit) { hideTag(); return; }
    liveRange = hit.range.cloneRange();

    var rects = hit.range.getClientRects();
    var last = rects[rects.length - 1] || hit.range.getBoundingClientRect();

    tagEl.hidden = false;
    var tw = tagEl.offsetWidth;
    var th = tagEl.offsetHeight;
    var col = reading.getBoundingClientRect();
    var edge = Math.min(col.right, document.documentElement.clientWidth - 10);

    var left, top;
    if (last.right + 10 + tw <= edge) {
      // the selection ended short of the margin, so sit on that same line and
      // cover nothing
      left = last.right + 10;
      top = last.top + (last.height - th) / 2;
    } else {
      // otherwise tuck under the last line, pinned inside the text column so it
      // never wanders out over the notebook
      left = Math.max(col.left, edge - tw);
      top = last.bottom + 4;
    }

    tagEl.style.left = (left + window.scrollX) + 'px';
    tagEl.style.top  = (top + window.scrollY) + 'px';
  }

  var selTimer;
  document.addEventListener('selectionchange', function () {
    clearTimeout(selTimer);
    selTimer = setTimeout(showTag, 90);
  });

  tagEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
  tagEl.addEventListener('click', function () {
    if (!liveRange) return;
    capture('note', liveRange, liveRange.toString());
  });

  /* ── Real keys, for the ones the browser lets through ── */
  var COMBO = {
    KeyC: 'note', Digit1: 'h1', Digit2: 'h2', Digit3: 'h3',
    KeyK: 'code', KeyB: 'bold', KeyI: 'italic', KeyZ: 'undo'
  };

  document.addEventListener('keydown', function (e) {
    var mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || !e.shiftKey || e.altKey) return;
    var kind = COMBO[e.code];
    if (!kind) return;

    if (kind === 'undo') {
      if (!entries.length) return;
      e.preventDefault();
      undoLast();
      flashRow('z');
      return;
    }

    var hit = currentSelection();
    if (!hit) return;
    e.preventDefault();
    flashRow(e.code === 'KeyC' ? 'c' : e.code.replace(/^(Key|Digit)/, '').toLowerCase());
    capture(kind, hit.range, hit.text);
  });

  function flashRow(combo) {
    var row = document.querySelector('.k-key[data-combo="' + combo + '"]');
    if (!row) return;
    var li = row.closest('li');
    li.classList.add('hit');
    setTimeout(function () { li.classList.remove('hit'); }, 320);
  }

  /* ── Notebook controls ──────────────────────────── */
  srcBox.addEventListener('change', function () {
    var on = srcBox.checked;
    entriesEl.querySelectorAll('.e-src').forEach(function (s) { s.hidden = !on; });
  });

  clearBtn.addEventListener('click', function () {
    clearAll();
    toast('notebook emptied');
  });

  saveBtn.addEventListener('click', function () {
    if (!entries.length) return;
    var lines = ['# Kept from casrion.com', ''];
    entries.forEach(function (e) {
      lines = lines.concat(KINDS[e.kind].md(e.text));
      if (srcBox.checked) lines.push('', '*Source: ' + e.src + '*');
      lines.push('');
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Casrion.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('saved Casrion.md');
  });

  /* ── Mobile drawer ──────────────────────────────── */
  function syncDrawer() {
    if (narrow()) {
      drawerTab.hidden = railEl.classList.contains('open');
    } else {
      drawerTab.hidden = true;
      railEl.classList.remove('open');
    }
  }
  drawerTab.addEventListener('click', function () {
    railEl.classList.add('open');
    syncDrawer();
  });
  document.addEventListener('click', function (e) {
    if (!narrow() || !railEl.classList.contains('open')) return;
    if (railEl.contains(e.target) || drawerTab.contains(e.target)) return;
    railEl.classList.remove('open');
    syncDrawer();
  });
  window.addEventListener('resize', syncDrawer);
  syncDrawer();

  /* ── The demo beat ──────────────────────────────────
     One marked sentence keeps itself the first time you scroll to it, so the
     mechanic explains itself without a tooltip telling you to try something. */
  var seed = document.querySelector('[data-auto]');
  if (seed && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (rows) {
      rows.forEach(function (row) {
        if (!row.isIntersecting || demoDone || entries.length) return;
        demoDone = true;
        io.disconnect();
        var run = function () {
          if (entries.length) return;
          var r = document.createRange();
          r.selectNodeContents(seed);
          capture('note', r, seed.textContent, { type: true });
          hintEl.textContent = 'Your turn. Select anything and click the tag.';
          hintEl.hidden = false;
          setTimeout(function () { hintEl.hidden = entries.length > 0; }, 5000);
          // on a phone the notebook is a drawer, so let it peek while the note
          // lands and then get out of the way again
          if (narrow()) setTimeout(function () {
            railEl.classList.remove('open');
            syncDrawer();
          }, 3400);
        };

        setTimeout(function () {
          if (narrow()) {
            railEl.classList.add('open');
            syncDrawer();
            setTimeout(run, 340);
          } else {
            run();
          }
        }, 900);
      });
    }, { threshold: 0.9 });
    io.observe(seed);
  }

  refreshChrome();
})();
