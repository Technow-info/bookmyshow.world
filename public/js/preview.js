// Review-only preview: desktop (scaled 1440px) + phone frame (390×844) side by side.
(function () {
  var stage = document.querySelector('.pv-stage');
  var desk = document.getElementById('f-desk'), phone = document.getElementById('f-phone');
  var vp = document.querySelector('.pv-desk-viewport');
  var sel = document.getElementById('pv-page'), url = document.getElementById('pv-url');
  function fit() { var s = vp.clientWidth / 1440; desk.style.transform = 'scale(' + s + ')'; }
  window.addEventListener('resize', fit); fit();
  if (window.ResizeObserver) new ResizeObserver(fit).observe(vp);
  document.querySelectorAll('[data-mode]').forEach(function (b) {
    if (!b.matches('button')) return;
    b.addEventListener('click', function () {
      stage.setAttribute('data-mode', b.dataset.mode);
      document.querySelectorAll('.pv-toggle button').forEach(function (x) { x.setAttribute('aria-checked', String(x === b)); });
      setTimeout(fit, 0);
    });
  });
  function go(p) { desk.src = p; phone.src = p; url.textContent = p; history.replaceState(null, '', '?page=' + encodeURIComponent(p)); }
  sel.addEventListener('change', function () { go(sel.value); });
  document.getElementById('pv-reload').addEventListener('click', function () { go(sel.value); });
  var start = new URLSearchParams(location.search).get('page');
  if (start) { sel.value = start; go(start); }
})();
