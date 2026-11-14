// Bookmyshow.world — shared front-end behaviour (no dependencies)
(function () {
  'use strict';
  var doc = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- Preloader → hero entrance (0.6–1.2s) ----
  var pre = document.querySelector('.preloader');
  var start = Date.now();
  function ready() {
    var wait = reduce ? 0 : Math.max(0, 700 - (Date.now() - start));
    setTimeout(function () {
      if (pre) { pre.classList.add('done'); setTimeout(function () { pre.remove(); }, 500); }
      doc.classList.add('is-ready');
    }, wait);
  }
  if (document.readyState === 'complete') ready(); else window.addEventListener('load', ready);
  setTimeout(ready, 1200); // never hold the page longer than 1.2s

  // ---- Header ----
  var header = document.querySelector('.site-header');
  function onScroll() { if (header) header.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  var menuBtn = document.querySelector('.menu-btn');
  var links = document.getElementById('nav-links');
  if (menuBtn && links) {
    menuBtn.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', function (e) { if (e.target.closest('a')) { links.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); } });
  }
  var y = document.getElementById('year'); if (y) y.textContent = new Date().getFullYear();

  // ---- Hero FX: follow-glow (touch + mouse), poster tilt, photo parallax, button ripple ----
  var hero = document.querySelector('.hero');
  if (hero && !reduce) {
    var fx = hero.querySelector('.hero-fx'), raf = 0, px = 0, py = 0;
    function glowAt(x, y) {
      var r = hero.getBoundingClientRect(); px = x - r.left; py = y - r.top;
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; if (fx) { fx.style.setProperty('--mx', px + 'px'); fx.style.setProperty('--my', py + 'px'); fx.style.setProperty('--glow', '1'); } });
    }
    hero.addEventListener('pointermove', function (e) { glowAt(e.clientX, e.clientY); }, { passive: true });
    hero.addEventListener('pointerdown', function (e) { glowAt(e.clientX, e.clientY); }, { passive: true });
    hero.addEventListener('touchmove', function (e) { var t = e.touches[0]; if (t) glowAt(t.clientX, t.clientY); }, { passive: true });
    hero.addEventListener('pointerleave', function () { if (fx) fx.style.setProperty('--glow', '0'); });

    var wrap = hero.querySelector('.poster-wrap');
    if (wrap && window.matchMedia('(hover:hover) and (pointer:fine)').matches) {
      var poster = wrap.querySelector('.poster');
      if (poster && !poster.querySelector('.shine')) { var sh = document.createElement('span'); sh.className = 'shine'; poster.appendChild(sh); }
      wrap.addEventListener('pointermove', function (e) {
        var r = wrap.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
        wrap.classList.add('tilting');
        wrap.style.transform = 'perspective(900px) rotateY(' + ((x - 0.5) * 10).toFixed(2) + 'deg) rotateX(' + ((0.5 - y) * 8).toFixed(2) + 'deg) scale(1.02)';
        poster.style.setProperty('--px', (x * 100).toFixed(1) + '%'); poster.style.setProperty('--py', (y * 100).toFixed(1) + '%');
      });
      wrap.addEventListener('pointerleave', function () { wrap.classList.remove('tilting'); wrap.style.transform = ''; });
    }

    var photo = hero.querySelector('.hero-photo-m');
    if (photo) {
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return; ticking = true;
        requestAnimationFrame(function () { ticking = false; var y = Math.min(window.scrollY, 600); photo.style.setProperty('--par', (y * 0.25).toFixed(1) + 'px'); });
      }, { passive: true });
    }
  }
  document.addEventListener('pointerdown', function (e) {
    var b = e.target.closest && e.target.closest('.btn'); if (!b || reduce) return;
    var r = b.getBoundingClientRect(), dot = document.createElement('span');
    dot.className = 'ripple'; dot.style.left = (e.clientX - r.left) + 'px'; dot.style.top = (e.clientY - r.top) + 'px';
    b.appendChild(dot); setTimeout(function () { dot.remove(); }, 650);
  }, { passive: true });

  // ---- Shared helpers ----
  window.Ember = window.Ember || {};
  Ember.api = function (url, opts) {
    opts = opts || {};
    return fetch(url, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
        return j;
      });
    });
  };
  Ember.status = function (el, kind, msg) {
    if (!el) return;
    el.className = 'status show ' + kind;
    el.textContent = msg;
  };

  // ---- Contact / query forms (contact page + footer) → /api/contact → Gmail ----
  document.querySelectorAll('form[data-contact]').forEach(function (form) {
    var started = Date.now();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var out = form.querySelector('.status');
      var btn = form.querySelector('button[type="submit"]');
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      data.elapsed = Date.now() - started; data.source = form.getAttribute('data-contact');
      var bad = null;
      form.querySelectorAll('[required]').forEach(function (f) {
        var ok = f.value.trim() && (f.type !== 'email' || /^\S+@\S+\.\S+$/.test(f.value));
        f.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (!ok && !bad) bad = f;
      });
      if (bad) { bad.focus(); Ember.status(out, 'err', 'Please fill in the highlighted fields.'); return; }
      btn.disabled = true; var label = btn.textContent; btn.textContent = 'Sending…';
      Ember.api('/api/contact', { method: 'POST', body: data })
        .then(function () { form.reset(); started = Date.now(); Ember.status(out, 'ok', 'Thank you. Your message has been sent to our support team, and we will reply by email.'); })
        .catch(function (err) { Ember.status(out, 'err', err.message); })
        .then(function () { btn.disabled = false; btn.textContent = label; });
    });
  });

  // ---- Ticket cards (home + tickets page) ----
  var tierHosts = document.querySelectorAll('[data-tiers]');
  if (tierHosts.length) {
    Ember.api('/api/tiers').then(function (res) {
      tierHosts.forEach(function (tierHost) {
      tierHost.innerHTML = '';
      res.tiers.forEach(function (t, i) {
        var card = document.createElement('article');
        card.className = 'tcard' + (t.featured ? ' hot' : '');
        var parts = (t.price / 100).toFixed(2).split('.');
        var whole = Number(parts[0]).toLocaleString('en-US');
        card.innerHTML =
          '<div class="top"><span class="tag"></span><span class="num"></span><h3 class="h3"></h3><p></p>' +
          (t.soldOut ? '<div class="flag">Sold out</div>' : t.fewLeft ? '<div class="flag">Few left</div>' : '') + '</div>' +
          '<div class="perf" aria-hidden="true"></div>' +
          '<div class="bottom"><div class="price"><span class="cur">AED</span><span>' + whole + '<span class="dec">.' + parts[1] + '</span></span></div>' +
          '<div class="row-btns">' +
          (t.soldOut ? '<button class="btn btn-primary" disabled>Sold out</button>'
                     : '<a class="btn btn-primary" href="/checkout?tier=' + encodeURIComponent(t.id) + '">Buy now</a>') +
          '<a class="alt" href="/contact?subject=' + encodeURIComponent(t.name) + '">Enquire instead</a></div></div>';
        card.querySelector('.tag').textContent = t.tag;
        card.querySelector('.num').textContent = String(i + 1).padStart(2, '0');
        card.querySelector('.h3').textContent = t.name;
        card.querySelector('p').textContent = t.desc;
        card.setAttribute('aria-label', t.name + ', ' + t.priceLabel);
        tierHost.appendChild(card);
      });
      });
    }).catch(function () {
      tierHosts.forEach(function (tierHost) { tierHost.innerHTML = '<p class="muted">Ticket options could not load. <a href="/contact">Contact support</a>.</p>'; });
    });
  }

  // Prefill contact subject from ?subject=
  var subj = new URLSearchParams(location.search).get('subject');
  var subjField = document.querySelector('#contact-form [name="subject"]');
  if (subj && subjField) {
    var match = Array.prototype.find.call(subjField.options, function (o) { return o.value === subj; });
    if (!match) { var o = new Option(subj, subj); subjField.add(o, 1); }
    subjField.value = subj;
  }
})();
