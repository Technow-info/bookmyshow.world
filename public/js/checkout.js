// Checkout: Select pass → Quantity & details → Review → Pay (Ziina hosted payment page) → Success / Failure
(function () {
  'use strict';
  var state = { tiers: [], days: [], tier: null, qty: 1, max: 10, testMode: true, booking: null, buyer: null, want: null };
  var $ = function (s) { return document.querySelector(s); };
  var aed = function (f) { return 'AED ' + (f / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var stepIds = ['step-tier', 'step-details', 'step-review', 'step-pay'];
  var KEY = 'bmsw:booking:';
  var store = {
    set: function (id, v) { try { sessionStorage.setItem(KEY + id, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    get: function (id) { try { return JSON.parse(sessionStorage.getItem(KEY + id) || 'null'); } catch (e) { return null; } },
  };

  function show(id) {
    document.querySelectorAll('.step').forEach(function (s) { s.classList.toggle('active', s.id === id); });
    var idx = stepIds.indexOf(id);
    document.querySelectorAll('.steps li').forEach(function (li, i) {
      li.classList.toggle('active', i === idx);
      li.classList.toggle('done', i < idx);
    });
    var main = $('#checkout-main'); if (main) main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderSummary() {
    var t = state.tier;
    $('#sum-tier').textContent = t ? t.name : '—';
    $('#sum-unit').textContent = t ? t.priceLabel : '—';
    $('#sum-qty').textContent = state.qty;
    $('#sum-total').textContent = t ? aed(t.price * state.qty) : '—';
    $('#qty-out').textContent = state.qty;
    $('#pay-btn').textContent = t ? 'Pay ' + aed(t.price * state.qty) : 'Pay';
    $('#day-field').hidden = !(t && t.pickDay);
  }

  function renderTiers() {
    var host = $('#tier-list'); host.innerHTML = '';
    state.tiers.forEach(function (t) {
      var lab = document.createElement('label');
      lab.className = 'tier-opt' + (state.tier && state.tier.id === t.id ? ' sel' : '');
      lab.innerHTML = '<input type="radio" name="tier"><span class="grow"><span class="nm"></span><br><span class="ds"></span></span><span class="pr"></span>';
      var input = lab.querySelector('input');
      input.value = t.id; input.disabled = t.soldOut; input.checked = !!(state.tier && state.tier.id === t.id);
      lab.querySelector('.nm').textContent = t.name + (t.soldOut ? ' (sold out)' : '');
      lab.querySelector('.ds').textContent = t.tag;
      lab.querySelector('.pr').textContent = t.priceLabel;
      input.addEventListener('change', function () { state.tier = t; renderTiers(); renderSummary(); });
      host.appendChild(lab);
    });
  }

  function err(id, msg) { var el = $(id); if (msg) Ember.status(el, 'err', msg); else el.className = 'status'; }

  // ---------- boot ----------
  var params = new URLSearchParams(location.search);
  Ember.api('/api/tiers').then(function (res) {
    state.tiers = res.tiers; state.days = res.days || []; state.testMode = res.testMode; state.max = res.maxQty || 10;
    var want = state.want || params.get('tier');
    state.tier = res.tiers.find(function (t) { return t.id === want && !t.soldOut; }) || null;
    if (state.testMode) $('#test-banner').hidden = false;
    var sel = $('#c-day'); sel.innerHTML = '<option value="">Choose a day</option>';
    state.days.forEach(function (d) { sel.add(new Option(d.label, d.id)); });
    renderTiers(); renderSummary();
  }).catch(function (e) { err('#tier-error', e.message); });

  $('#to-details').addEventListener('click', function () {
    if (!state.tier) return err('#tier-error', 'Please choose a pass to continue.');
    err('#tier-error'); renderSummary(); show('step-details');
  });
  $('#qty-minus').addEventListener('click', function () { state.qty = Math.max(1, state.qty - 1); renderSummary(); });
  $('#qty-plus').addEventListener('click', function () { state.qty = Math.min(state.max, state.qty + 1); renderSummary(); });

  $('#details-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target, bad = null;
    var fields = ['name', 'email', 'phone']; if (state.tier.pickDay) fields.unshift('day');
    fields.forEach(function (k) {
      var el = f.elements[k], v = el.value.trim();
      var ok = k === 'email' ? /^\S+@\S+\.\S+$/.test(v) : k === 'phone' ? /^[+\d][\d\s-]{6,18}$/.test(v) : k === 'day' ? !!v : v.length >= 2;
      el.setAttribute('aria-invalid', ok ? 'false' : 'true');
      if (!ok && !bad) bad = el;
    });
    if (bad) { bad.focus(); return err('#details-error', bad.name === 'day' ? 'Please choose your festival day.' : 'Please check the highlighted fields.'); }
    err('#details-error');
    var daySel = f.elements.day;
    state.buyer = { name: f.elements.name.value.trim(), email: f.elements.email.value.trim(), phone: f.elements.phone.value.trim(),
      day: state.tier.pickDay ? daySel.value : null, dayLabel: state.tier.pickDay ? daySel.options[daySel.selectedIndex].text : null };
    $('#rv-tier').textContent = state.tier.name + ' × ' + state.qty;
    $('#rv-day-row').hidden = !state.buyer.day; $('#rv-day').textContent = state.buyer.dayLabel || '';
    $('#rv-name').textContent = state.buyer.name;
    $('#rv-email').textContent = state.buyer.email;
    $('#rv-phone').textContent = state.buyer.phone;
    $('#rv-total').textContent = aed(state.tier.price * state.qty);
    show('step-review');
  });
  document.querySelectorAll('[data-back]').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-back')); }); });

  // ---------- pay ----------
  $('#pay-btn').addEventListener('click', function () {
    if (!$('#agree').checked) return err('#review-error', 'Please tick the box to confirm you have read the ticket note.');
    err('#review-error');
    processing('Creating your order…');
    Ember.api('/api/orders', { method: 'POST', body: { tierId: state.tier.id, qty: state.qty, day: state.buyer.day, name: state.buyer.name, email: state.buyer.email, phone: state.buyer.phone } })
      .then(function (order) {
        state.booking = order;
        store.set(order.bookingId, { token: order.token, email: state.buyer.email });
        if (order.testMode) return testPay(order);
        processing('Taking you to Ziina’s secure payment page…');
        window.location.href = order.checkoutUrl;
      })
      .catch(function (e) { fail(e.message); });
  });

  function processing(msg) {
    $('#pay-body').innerHTML = '<div class="result" role="status" aria-live="polite"><div class="spinner"></div><h2 class="h3"></h2><p class="muted">Please don\'t close this page.</p></div>';
    $('#pay-body h2').textContent = msg;
    show('step-pay');
  }

  function verify(bookingId, token, payload, email) {
    processing('Confirming your payment…');
    payload = payload || {}; payload.token = token;
    return Ember.api('/api/orders/' + encodeURIComponent(bookingId) + '/verify', { method: 'POST', body: payload })
      .then(function (r) {
        if (r.status === 'paid') success(bookingId, email, r.ticketUrl);
        else if (r.status === 'pending') pendingNote(bookingId);
        else fail('Your payment was not completed.');
      })
      .catch(function (e) { fail(e.message); });
  }

  function testPay(order) {
    $('#pay-body').innerHTML =
      '<div class="testpay"><p class="eyebrow">Test mode: no money moves</p>' +
      '<h2 class="h3">Simulated payment of <span id="tp-amt"></span></h2>' +
      '<p class="muted">No Ziina API key is configured on the server yet, so this step stands in for Ziina\'s payment page. Add ZIINA_API_KEY to the server settings to take real payments.</p>' +
      '<div class="actions"><button class="btn btn-solid" id="tp-ok">Simulate success</button><button class="btn btn-outline" id="tp-fail">Simulate failure</button></div></div>';
    $('#tp-amt').textContent = order.amountLabel;
    $('#tp-ok').onclick = function () { verify(order.bookingId, order.token, { testOutcome: 'success' }, state.buyer.email); };
    $('#tp-fail').onclick = function () { verify(order.bookingId, order.token, { testOutcome: 'fail' }, state.buyer.email); };
  }

  function success(bookingId, email, ticketUrl) {
    $('#pay-body').innerHTML =
      '<div class="result"><div class="badge ok"><svg class="icon"><use href="/img/icons.svg#check"/></svg></div>' +
      '<p class="eyebrow">Payment received</p><h2 class="h2">Your tickets are on the way</h2>' +
      '<div class="ref" id="ok-ref"></div>' +
      '<p class="muted">Your e-tickets with QR codes have been emailed to <b id="ok-mail"></b>. If they are not in your inbox in a few minutes, check spam or contact support with this booking reference.</p>' +
      '<p style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap"><a class="btn btn-primary" id="ok-view" target="_blank" rel="noopener">View my tickets</a><a class="btn btn-outline" href="/info">Event information</a></p></div>';
    $('#ok-ref').textContent = bookingId;
    $('#ok-mail').textContent = email || 'your email';
    var v = $('#ok-view'); if (ticketUrl) v.href = ticketUrl; else v.remove();
    show('step-pay');
    document.querySelectorAll('.steps li').forEach(function (li) { li.classList.remove('active'); li.classList.add('done'); });
  }

  function pendingNote(bookingId) {
    $('#pay-body').innerHTML =
      '<div class="result"><div class="spinner"></div><p class="eyebrow">Payment processing</p><h2 class="h3">We\'re waiting for confirmation from your bank</h2>' +
      '<p class="muted">Booking reference <b id="pn-ref"></b>. You\'ll get an email as soon as the payment is confirmed. You can safely close this page.</p></div>';
    $('#pn-ref').textContent = bookingId;
    show('step-pay');
  }

  function fail(msg) {
    $('#pay-body').innerHTML =
      '<div class="result"><div class="badge err"><svg class="icon"><use href="/img/icons.svg#x"/></svg></div>' +
      '<p class="eyebrow">Payment not completed</p><h2 class="h3" id="f-msg"></h2>' +
      '<p class="muted">No money has been taken for this attempt. If your account was debited, your bank reverses it automatically.</p>' +
      '<p style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap"><button class="btn btn-solid" id="retry">Try again</button><a class="btn btn-outline" href="/contact?subject=Payment">Get help</a></p></div>';
    $('#f-msg').textContent = msg;
    show('step-pay');
    $('#retry').onclick = function () { if (state.tier && state.buyer) show('step-review'); else window.location.href = '/checkout'; };
  }

  // Returning from Ziina: /checkout?b=<booking>&return=success|cancel|failure
  var back = params.get('b'), ret = params.get('return');
  if (back && ret) {
    var saved = store.get(back);
    history.replaceState(null, '', '/checkout');
    if (!saved) {
      ret === 'success' ? pendingNote(back) : fail(ret === 'failure' ? 'Your payment did not go through.' : 'Checkout was cancelled.');
    } else if (ret === 'success') verify(back, saved.token, {}, saved.email);
    else verify(back, saved.token, { failed: true, reason: ret === 'failure' ? 'Payment failed' : 'Checkout cancelled' }, saved.email);
  }

  // Used by the single-page preview build
  Ember.openCheckout = function (id) {
    state.want = id; state.qty = 1;
    if (state.tiers.length) { var t = state.tiers.find(function (x) { return x.id === id && !x.soldOut; }); if (t) state.tier = t; renderTiers(); renderSummary(); }
    var agree = $('#agree'); if (agree) agree.checked = false;
    show('step-tier');
  };
})();
