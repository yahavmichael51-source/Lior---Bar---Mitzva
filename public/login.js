// Corner "כניסה" button on the guest page: opens a username/password dialog and,
// on success, goes to the statistics page (/admin). Credentials are checked only on the server.
(function () {
  var dialog = document.getElementById('loginDialog');
  var form = document.getElementById('loginForm');
  var errorEl = document.getElementById('loginError');
  var submit = document.getElementById('loginSubmit');

  document.getElementById('loginOpen').addEventListener('click', function () {
    errorEl.textContent = '';
    dialog.showModal();
    document.getElementById('loginUser').focus();
  });
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
        window.location.href = '/admin';
      })
      .catch(function (err) {
        errorEl.textContent = err.message === 'Failed to fetch' ? 'אין חיבור לאינטרנט. נסו שוב.' : err.message;
      })
      .finally(function () { submit.disabled = false; });
  });
})();
