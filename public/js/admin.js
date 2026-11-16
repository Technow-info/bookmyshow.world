// Admin dashboard: login, KPIs, charts (hand-drawn SVG, no libraries), bookings table, queries inbox.
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var inr = function (p) { return 'AED ' + (p / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var aedShort = function (p) { return 'AED ' + Math.round(p / 100).toLocaleString('en-US'); };
  var num = function (n) { return Number(n).toLocaleString('en-US'); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmtDate = function (iso) { var d = new Date(iso); return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); };
  var shortDay = function (d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };
  var filter = { status: 'all', q: '', qstatus: 'all' }; var seenQueries = null; var baseTitle = document.title; var PAGE = 25, shown = PAGE;
  var tip = $('#tip');

  function api(url, opts) {
    opts = opts || {};
    return fetch(url, { method: opts.method || 'GET', credentials: 'same-origin', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (r.status === 401) { showLogin(); throw new Error('auth'); } if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); });
  }

  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#pw').focus(); }
  function showApp() { $('#login').hidden = true; $('#app').hidden = false; }

  $('#login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var out = e.target.querySelector('.status');
    api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } })
      .then(function () { $('#pw').value = ''; out.className = 'status'; showApp(); loadAll(); })
      .catch(function (err) { if (err.message !== 'auth') { out.className = 'status show err'; out.textContent = err.message; } });
  });
  $('#logout').addEventListener('click', function () { api('/api/admin/logout', { method: 'POST' }).then(showLogin); });
  $('#refresh').addEventListener('click', loadAll);

  // ---------- tooltip ----------
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, x + 14) + 'px';
    tip.style.top = Math.max(8, y - h - 12) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  // ---------- KPIs ----------
  function renderKpis(s) {
    var t = s.totals;
    $('#k-bookings').textContent = num(t.bookings);
    $('#k-bookings-sub').textContent = t.todayBookings + ' today';
    $('#k-tickets').textContent = num(t.tickets);
    var capped = s.tiers.every(function (x) { return x.capacity != null; });
    var cap = s.tiers.reduce(function (n, x) { return n + (x.capacity || 0); }, 0);
    var soldUnits = s.tiers.reduce(function (n, x) { return n + x.sold; }, 0);
    $('#k-tickets-sub').textContent = capped && cap ? Math.round((soldUnits / cap) * 1000) / 10 + '% of pass capacity' : 'Across all pass types';
    $('#k-revenue').textContent = aedShort(t.revenue);
    $('#k-revenue-sub').textContent = inr(t.todayRevenue) + ' today';
    $('#k-today').textContent = t.todayBookings + ' · ' + aedShort(t.todayRevenue);
    $('#k-avg').textContent = t.avgOrder ? aedShort(t.avgOrder) : '—';
    $('#k-rate').textContent = t.successRate == null ? '—' : Math.round(t.successRate * 100) + '%';
    $('#k-pend').textContent = t.pending + ' / ' + t.failed;
    $('#k-queries').textContent = t.newQueries;
    var mp = $('#mode-pay'), mm = $('#mode-mail');
    mp.textContent = s.mode.payments === 'live' ? 'Ziina live' : s.mode.payments === 'ziina-test' ? 'Ziina test payments' : 'Payments: simulated';
    mp.className = 'pill ' + (s.mode.payments === 'live' ? 'good' : 'warn');
    var sw = $('#store-warn');
    if (sw) { sw.hidden = !s.mode.storageWarning; sw.textContent = 'Storage is temporary: connect Upstash Redis or bookings will be lost'; }
    mm.textContent = s.mode.mail === 'on' ? 'Gmail on' : 'Gmail off';
    mm.className = 'pill ' + (s.mode.mail === 'on' ? 'good' : 'warn');
    var tw = $('#tk-warn'); tw.hidden = !t.ticketsPending;
    tw.textContent = s.mode.mail === 'off' ? 'Email not set up: ' + t.ticketsPending + ' e-ticket email' + (t.ticketsPending === 1 ? '' : 's') + ' not sent' : t.ticketsPending + ' ticket email' + (t.ticketsPending === 1 ? '' : 's') + ' not delivered: use Resend';
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- line chart: bookings per day ----------
  function renderDays(days) {
    var host = $('#chart-days');
    var W = host.clientWidth || 600, H = host.clientHeight || 240, pl = 34, pr = 12, pt = 10, pb = 26;
    var max = Math.max(4, Math.max.apply(null, days.map(function (d) { return d.bookings; })));
    var step = Math.ceil(max / 4); max = step * 4;
    var x = function (i) { return pl + (i * (W - pl - pr)) / (days.length - 1); };
    var y = function (v) { return pt + (H - pt - pb) * (1 - v / max); };
    var pts = days.map(function (d, i) { return [x(i), y(d.bookings)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
    var area = line + 'L' + x(days.length - 1) + ' ' + y(0) + 'L' + x(0) + ' ' + y(0) + 'Z';
    var grid = '', axis = '';
    for (var g = 0; g <= 4; g++) { var gv = step * g; grid += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y(gv) + '" y2="' + y(gv) + '"/>'; axis += '<text x="' + (pl - 8) + '" y="' + (y(gv) + 4) + '" text-anchor="end">' + gv + '</text>'; }
    days.forEach(function (d, i) { if (i % 2 === 0 || i === days.length - 1) axis += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + shortDay(d.date) + '</text>'; });
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ec8830" stop-opacity=".35"/><stop offset="1" stop-color="#ec8830" stop-opacity="0"/></linearGradient></defs>' +
      '<g class="grid">' + grid + '</g><g class="axis">' + axis + '</g>' +
      '<path class="area" d="' + area + '"/><path class="ln" d="' + line + '"/>' +
      '<line class="cross" id="cross" y1="' + pt + '" y2="' + y(0) + '" visibility="hidden"/><circle class="dot" id="hdot" r="5" visibility="hidden"/>' +
      '<rect id="hit" x="' + pl + '" y="0" width="' + (W - pl - pr) + '" height="' + H + '" fill="transparent"/></svg>';
    var svg = host.querySelector('svg'), cross = svg.querySelector('#cross'), dot = svg.querySelector('#hdot');
    svg.querySelector('#hit').addEventListener('mousemove', function (e) {
      var r = svg.getBoundingClientRect();
      var px = ((e.clientX - r.left) / r.width) * W;
      var i = Math.max(0, Math.min(days.length - 1, Math.round(((px - pl) / (W - pl - pr)) * (days.length - 1))));
      var d = days[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(d.bookings)); dot.setAttribute('visibility', 'visible');
      showTip('<b>' + shortDay(d.date) + '</b>' + d.bookings + ' bookings · ' + d.tickets + ' passes<br>' + inr(d.revenue), e.clientX, e.clientY);
    });
    svg.querySelector('#hit').addEventListener('mouseleave', function () { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
    $('#days-table').innerHTML = '<table class="schedule"><thead><tr><th>Date</th><th>Bookings</th><th>Passes</th><th>Revenue</th></tr></thead><tbody>' +
      days.map(function (d) { return '<tr><td>' + shortDay(d.date) + '</td><td>' + d.bookings + '</td><td>' + d.tickets + '</td><td>' + inr(d.revenue) + '</td></tr>'; }).join('') + '</tbody></table>';
  }

  // ---------- bars: tiers vs capacity ----------
  function renderTiers(tiers) {
    var host = $('#chart-tiers');
    var maxSold = Math.max.apply(null, tiers.map(function (t) { return t.sold; }).concat([1]));
    host.innerHTML = '<div class="bars">' + tiers.map(function (t, i) {
      var capped = t.capacity != null;
      var pct = capped ? Math.min(100, (t.sold / t.capacity) * 100) : (t.sold / maxSold) * 100;
      return '<div class="bar-row" data-i="' + i + '"><div class="bar-top"><span>' + esc(t.name) + '</span><b>' + num(t.sold) + (capped ? ' / ' + num(t.capacity) : ' sold') + '</b></div>' +
        '<div class="track"><div class="fill" style="width:' + Math.max(pct, t.sold ? 1 : 0).toFixed(2) + '%"></div></div>' +
        '<div class="bar-sub">' + aedShort(t.revenue) + (capped ? ' · ' + pct.toFixed(1) + '% sold' : '') + '</div></div>';
    }).join('') + '</div>';
    host.querySelectorAll('.bar-row').forEach(function (row) {
      var t = tiers[row.dataset.i];
      row.addEventListener('mousemove', function (e) { showTip('<b>' + esc(t.name) + '</b>' + num(t.sold) + ' sold' + (t.capacity != null ? ' of ' + num(t.capacity) + '<br>' + num(t.capacity - t.sold) + ' left' : '') + '<br>' + inr(t.revenue), e.clientX, e.clientY); });
      row.addEventListener('mouseleave', hideTip);
    });
  }

  // ---------- bookings table ----------
  var ICON = { simulated: 'check', paid: 'check', pending: 'clock', failed: 'x', sent: 'check', skipped: 'clock', sending: 'clock' };
  var TK_LABEL = { simulated: 'Emailed (preview)', sent: 'Emailed', failed: 'Email failed', skipped: 'Not sent (mail off)', sending: 'Sending…' };
  function ticketCell(b) {
    if (b.status === 'pending' && b.gateway === 'ziina') return '<div class="tk-cell"><button class="icon-btn" data-sync="' + esc(b.id) + '" title="Re-check this payment with Ziina"><svg class="icon"><use href="/img/icons.svg#refresh"/></svg></button><span class="fine">Re-check</span></div>';
    if (b.status !== 'paid') return '<span class="muted">—</span>';
    var st = (b.ticketEmail && b.ticketEmail.status) || 'sending';
    var title = b.ticketEmail && b.ticketEmail.error ? ' title="' + esc(b.ticketEmail.error) + '"' : '';
    return '<div class="tk-cell"><span class="badge-s ' + st + '"' + title + '><svg class="icon"><use href="/img/icons.svg#' + (ICON[st] || 'clock') + '"/></svg>' + (TK_LABEL[st] || st) + '</span>' +
      (b.ticketUrl ? '<a class="icon-btn" href="' + esc(b.ticketUrl) + '" target="_blank" rel="noopener" title="View e-tickets"><svg class="icon"><use href="/img/icons.svg#ticket"/></svg></a>' : '') +
      '<button class="icon-btn" data-resend="' + esc(b.id) + '" title="Resend e-tickets to ' + esc(b.email) + '"><svg class="icon"><use href="/img/icons.svg#mail"/></svg></button></div>';
  }
  function loadBookings() {
    var qs = '?status=' + encodeURIComponent(filter.status) + '&q=' + encodeURIComponent(filter.q);
    return api('/api/admin/bookings' + qs).then(function (r) {
      var body = $('#bk-body');
      if (!r.bookings.length) { body.innerHTML = '<tr><td colspan="9" class="muted">No bookings match.</td></tr>'; }
      else body.innerHTML = r.bookings.slice(0, shown).map(function (b) {
        return '<tr><td><b>' + esc(b.id) + '</b>' + (b.paymentId ? '<span class="sub">' + esc(b.paymentId) + '</span>' : '') + '</td>' +
          '<td><span class="badge-s ' + b.status + '"><svg class="icon"><use href="/img/icons.svg#' + ICON[b.status] + '"/></svg>' + b.status[0].toUpperCase() + b.status.slice(1) + '</span>' + (b.failReason ? '<span class="sub">' + esc(b.failReason) + '</span>' : '') + '</td>' +
          '<td>' + esc(b.tierName) + (b.dayLabel ? '<span class="sub">' + esc(b.dayLabel) + '</span>' : '') + '</td><td>' + b.qty + '</td><td class="num">' + inr(b.amount) + '</td>' +
          '<td>' + esc(b.name) + '<span class="sub">' + esc(b.email) + '</span></td><td>' + esc(b.phone) + '</td><td>' + fmtDate(b.createdAt) + '</td><td>' + ticketCell(b) + '</td></tr>';
      }).join('');
      var n = Math.min(shown, r.bookings.length);
      $('#bk-count').innerHTML = 'Showing ' + n + ' of ' + r.total + ' bookings' + (n < r.bookings.length ? ' · <button class="btn btn-outline" id="more" style="padding:8px 16px;font-size:12px">Show 25 more</button>' : '');
      var more = $('#more'); if (more) more.onclick = function () { shown += PAGE; loadBookings(); };
      body.querySelectorAll('[data-sync]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          api('/api/admin/bookings/' + encodeURIComponent(btn.dataset.sync) + '/sync', { method: 'POST' })
            .then(function (x) { toast('Ziina says: ' + x.status + ' (' + btn.dataset.sync + ')'); })
            .catch(function (e) { if (e.message !== 'auth') toast('Re-check failed: ' + e.message); })
            .then(function () { loadBookings(); refreshStats(); });
        });
      });
      body.querySelectorAll('[data-resend]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          api('/api/admin/bookings/' + encodeURIComponent(btn.dataset.resend) + '/resend', { method: 'POST' })
            .then(function (x) { toast('E-tickets ' + (x.status === 'sent' ? 'resent' : x.status) + ' for ' + btn.dataset.resend); })
            .catch(function (e) { if (e.message !== 'auth') toast('Resend failed: ' + e.message); })
            .then(function () { loadBookings(); loadEmails(); });
        });
      });
    });
  }
  document.querySelectorAll('.chips button').forEach(function (b) {
    b.addEventListener('click', function () {
      filter.status = b.dataset.status; shown = PAGE;
      document.querySelectorAll('.chips button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
      loadBookings();
    });
  });
  var t; $('#q').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { filter.q = e.target.value.trim(); shown = PAGE; loadBookings(); }, 250); });

  // ---------- queries ----------
  function loadQueries() {
    return api('/api/admin/queries').then(function (r) {
      var host = $('#q-list');
      var ids = r.queries.map(function (q) { return q.id; });
      var fresh = seenQueries ? r.queries.filter(function (q) { return seenQueries.indexOf(q.id) < 0; }) : [];
      seenQueries = ids;
      if (fresh.length) {
        toast('<b>New query from ' + esc(fresh[0].name) + '</b>' + esc(fresh[0].subject) + (fresh.length > 1 ? ' (+' + (fresh.length - 1) + ' more)' : ''), function () { $('#q-title').scrollIntoView({ behavior: 'smooth' }); });
      }
      var newCount = r.queries.filter(function (q) { return q.status === 'new'; }).length;
      document.title = (newCount ? '(' + newCount + ') ' : '') + baseTitle;
      var kq = document.querySelector('.kpi-link'); if (kq) kq.classList.toggle('hot', newCount > 0);
      var list = filter.qstatus === 'all' ? r.queries : r.queries.filter(function (q) { return q.status === filter.qstatus; });
      if (!list.length) { host.innerHTML = '<p class="muted">' + (r.queries.length ? 'No queries in this view.' : 'No queries yet. They appear here the moment a customer sends one.') + '</p>'; return; }
      host.innerHTML = list.map(function (q) {
        return '<div class="q-item ' + q.status + (fresh.some(function (f) { return f.id === q.id; }) ? ' flash' : '') + '"><div><span class="who">' + esc(q.name) + '</span> <span class="meta">· ' + esc(q.subject) + ' · ' + fmtDate(q.createdAt) + (q.mailed === false ? ' · not emailed' : '') + '</span>' +
          '<div class="meta">' + esc(q.email) + (q.phone ? ' · ' + esc(q.phone) : '') + ' · ref ' + esc(q.id) + '</div></div>' +
          '<div class="acts"><a class="icon-btn" title="Reply by email" href="mailto:' + encodeURIComponent(q.email) + '?subject=' + encodeURIComponent('Re: ' + q.subject) + '"><svg class="icon"><use href="/img/icons.svg#mail"/></svg></a>' +
          '<select data-id="' + esc(q.id) + '" aria-label="Status"><option value="new"' + (q.status === 'new' ? ' selected' : '') + '>New</option><option value="replied"' + (q.status === 'replied' ? ' selected' : '') + '>Replied</option><option value="closed"' + (q.status === 'closed' ? ' selected' : '') + '>Closed</option></select></div>' +
          '<p class="msg">' + esc(q.message) + '</p></div>';
      }).join('');
      host.querySelectorAll('select').forEach(function (s) {
        s.addEventListener('change', function () { api('/api/admin/queries/' + encodeURIComponent(s.dataset.id), { method: 'PATCH', body: { status: s.value } }).then(function () { loadQueries(); refreshStats(); }); });
      });
    });
  }

  document.querySelectorAll('[data-qstatus]').forEach(function (b) {
    b.addEventListener('click', function () {
      filter.qstatus = b.dataset.qstatus;
      document.querySelectorAll('[data-qstatus]').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
      loadQueries();
    });
  });

  var KIND = { ticket: 'E-tickets', query: 'Query alert', 'booking-alert': 'Booking alert' };
  function loadEmails() {
    return api('/api/admin/emails').then(function (r) {
      var host = $('#e-list');
      if (!r.emails.length) { host.innerHTML = '<p class="muted">No emails yet.</p>'; return; }
      host.innerHTML = r.emails.slice(0, 40).map(function (e) {
        return '<div class="e-row"><span class="badge-s ' + e.status + '"><svg class="icon"><use href="/img/icons.svg#' + (ICON[e.status] || 'x') + '"/></svg>' + e.status + '</span>' +
          '<span class="subj">' + esc(KIND[e.kind] || e.kind) + ' → ' + esc(e.to) + '</span><span class="fine">' + fmtDate(e.at) + '</span>' +
          '<span class="meta">' + esc(e.subject) + (e.error ? ' · <b style="color:var(--err-400)">' + esc(e.error) + '</b>' : '') + '</span></div>';
      }).join('');
    });
  }

  $('#verify-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var out = $('#v-out'), code = $('#v-code').value.trim();
    if (!code) return;
    api('/api/admin/tickets/verify?code=' + encodeURIComponent(code)).then(function (r) {
      if (r.valid) { out.className = 'status show ok'; out.innerHTML = '<span><b>Valid ticket ' + esc(r.code) + '</b><br>' + esc(r.booking.name) + ' · ' + esc(r.booking.tierName) + (r.booking.dayLabel ? ' · ' + esc(r.booking.dayLabel) : '') + (r.signed ? ' · QR signature verified' : ' · typed code (no QR signature)') + '</span>'; }
      else { out.className = 'status show err'; out.textContent = 'Not valid: ' + r.reason; }
    }).catch(function (err) { if (err.message !== 'auth') { out.className = 'status show err'; out.textContent = err.message; } });
  });

  var toastTimer;
  function toast(html, onClick) {
    var t = $('#toast'); t.innerHTML = html; t.hidden = false;
    t.onclick = function () { t.hidden = true; if (onClick) onClick(); };
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 6000);
  }

  var last;
  function refreshStats() { return api('/api/admin/stats').then(function (s) { last = s; renderKpis(s); renderDays(s.perDay); renderTiers(s.tiers); }); }
  function loadAll() {
    return api('/api/admin/stats').then(function (s) {
      showApp(); last = s; renderKpis(s); renderDays(s.perDay); renderTiers(s.tiers);
      return Promise.all([loadBookings(), loadQueries(), loadEmails()]);
    }).catch(function (e) { if (e.message !== 'auth') console.error(e); });
  }
  window.addEventListener('resize', function () { if (last) renderDays(last.perDay); });
  // Live: new queries and payments appear within ~10 seconds without reloading.
  setInterval(function () {
    if ($('#app').hidden || document.hidden) return;
    Promise.all([loadQueries(), refreshStats(), loadEmails()]).catch(function () {});
    if (!$('#q').value) loadBookings().catch(function () {});
  }, 10000);
  loadAll();
})();
