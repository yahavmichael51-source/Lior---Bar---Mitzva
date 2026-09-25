// Organizer login on the guest page. Guests don't see the "כניסה" button: it appears only on a
// device that opened the site once with "?admin" at the end of the link (or already logged in).
// Credentials are checked only on the server.
(function () {
  var FLAG = 'rsvp-admin-device';
  var openBtn = document.getElementById('loginOpen');
  var dialog = document.getElementById('loginDialog');
  var form = document.getElementById('loginForm');
  var errorEl = document.getElementById('loginError');
  var submit = document.getElementById('loginSubmit');

  function flagged() {
    try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; }
  }
  function flag() {
    try { localStorage.setItem(FLAG, '1'); } catch (e) {}
  }

  function open() {
    errorEl.textContent = '';
    dialog.showModal();
    document.getElementById('loginUser').focus();
  }

  var askedForLogin = /(?:^|[?&])admin(?:=|&|$)/.test(window.location.search.slice(1));
  if (askedForLogin) {
    flag();
    // Tidy the address bar so "?admin" isn't copied along if the link is shared.
    try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
  }
  openBtn.hidden = !(askedForLogin || flagged());
  openBtn.addEventListener('click', open);
  if (askedForLogin) open();

  document.getElementById('loginCancel').addEventListener('click', function () { dialog.close(); });
  form.addEventListener('input', function () { errorEl.textContent = ''; });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submit.disabled = true;
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('loginUser').value, password: document.getElementById('loginPass').value })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'הכניסה נכשלה');
        flag();
        window.location.href = '/admin';
      })
      .catch(function (err) {
        errorEl.textContent = err.message === 'Failed to fetch' ? 'אין חיבור לאינטרנט. נסו שוב.' : err.message;
      })
      .finally(function () { submit.disabled = false; });
  });
})();
