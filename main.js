// Casrion field manual site. No dependencies.
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var search = location.search;
  var instant = reduced ||
    search.indexOf('noanim') !== -1 ||
    search.indexOf('shots') !== -1 ||
    !('IntersectionObserver' in window);

  /* Scroll progress hairline */
  var progress = document.querySelector('.scroll-progress');
  function onScroll() {
    if (!progress) return;
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    progress.style.transform = 'scaleX(' + (max > 0 ? window.scrollY / max : 0) + ')';
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Split each ASCII divider into characters for a staggered fade */
  document.querySelectorAll('.divider').forEach(function (div) {
    var text = div.textContent;
    div.textContent = '';
    for (var i = 0; i < text.length; i++) {
      var s = document.createElement('span');
      s.textContent = text[i];
      s.style.setProperty('--d', (i * 22) + 'ms');
      div.appendChild(s);
    }
  });

  /* Reveal on scroll. Elements already in the viewport reveal immediately. */
  var targets = document.querySelectorAll('.reveal, .stamp-reveal, .note-reveal, .divider');
  if (instant) {
    document.documentElement.classList.add('no-anim');
    targets.forEach(function (el) { el.classList.add('in-view'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in-view');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });
    targets.forEach(function (el) {
      if (el.getBoundingClientRect().top < window.innerHeight) {
        el.classList.add('in-view');
      } else {
        io.observe(el);
      }
    });
  }

  /* ── Story: plates crossfade as steps scroll by ── */
  var steps = document.querySelectorAll('.story-step');
  var plates = document.querySelectorAll('.story-plate');
  var storyCap = document.getElementById('story-cap');

  function setPlate(step) {
    var idx = parseInt(step.getAttribute('data-plate'), 10) || 0;
    plates.forEach(function (p, i) { p.classList.toggle('is-active', i === idx); });
    steps.forEach(function (s) { s.classList.toggle('is-current', s === step); });
    if (storyCap) storyCap.textContent = step.getAttribute('data-cap') || '';
  }

  if (steps.length && !instant) {
    setPlate(steps[0]);
    var storyIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) setPlate(e.target);
      });
    }, { rootMargin: '-40% 0px -40% 0px', threshold: 0 });
    steps.forEach(function (s) { storyIo.observe(s); });
  } else if (steps.length) {
    steps.forEach(function (s) { s.classList.add('is-current'); });
  }

  /* ── Masked parallax: images drift inside frames ── */
  var plxFrames = [];
  document.querySelectorAll('[data-plx]').forEach(function (el) {
    plxFrames.push({ el: el, strength: parseFloat(el.getAttribute('data-plx')) || 24 });
  });

  if (plxFrames.length && !instant) {
    var ticking = false;
    var applyParallax = function () {
      ticking = false;
      var vh = window.innerHeight;
      plxFrames.forEach(function (f) {
        var r = f.el.getBoundingClientRect();
        if (r.bottom < -80 || r.top > vh + 80) return;
        var progress = (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2);
        if (progress > 1) progress = 1;
        if (progress < -1) progress = -1;
        f.el.style.setProperty('--plx', (progress * f.strength).toFixed(1) + 'px');
      });
    };
    var requestParallax = function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(applyParallax);
      }
    };
    window.addEventListener('scroll', requestParallax, { passive: true });
    window.addEventListener('resize', requestParallax);
    applyParallax();
  }

  /* ── Frontispiece: the note writes itself ───────── */
  var fnLineEl = document.querySelector('.fn-line');
  var fnTyped = document.getElementById('fn-typed');
  var fnSrc = document.getElementById('fn-src');

  if (fnLineEl && fnTyped) {
    var fnText = fnLineEl.getAttribute('data-text') || '';
    if (instant) {
      fnTyped.textContent = fnText;
      if (fnSrc) fnSrc.classList.add('on');
    } else {
      var fnPos = 0;
      var typeNote = function () {
        fnTyped.textContent = fnText.slice(0, fnPos);
        if (fnPos < fnText.length) {
          fnPos += 1;
          setTimeout(typeNote, 38);
        } else {
          if (fnSrc) fnSrc.classList.add('on');
          setTimeout(function () {
            fnPos = 0;
            if (fnSrc) fnSrc.classList.remove('on');
            typeNote();
          }, 4200);
        }
      };
      /* Start after the slip has stamped in */
      setTimeout(typeNote, 1700);
    }
  }

  /* ── Specimen B: the quick writer typing ────────── */
  var typed = document.getElementById('q-typed');
  var qCursor = document.getElementById('q-cursor');
  var draft = '# Study plan\nRead Alberti chapter two\n> Perspective is the rein and rudder of painting';

  if (typed && !instant) {
    var pos = 0;
    (function tick() {
      typed.textContent = draft.slice(0, pos);
      if (pos < draft.length) {
        pos += 1;
        setTimeout(tick, 50);
      } else {
        setTimeout(function () { pos = 0; tick(); }, 2800);
      }
    })();
  } else if (typed) {
    typed.textContent = draft;
    if (qCursor) qCursor.classList.remove('on');
  }

})();
