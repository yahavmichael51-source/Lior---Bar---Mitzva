(function () {
  var LABELS = { yes: 'מגיע/ה', no: 'לא מגיע/ה', maybe: 'עוד לא יודע/ת' };
  function sizeLabel(n) { return n === 1 ? 'רק אני' : 'אני + ' + (n - 1); }
  var $ = function (id) { return document.getElementById(id); };
  var state = { responses: [], filter: '', editing: null };
  var timeFmt = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  function api(url, opts) {
    opts = opts || {};
    if (opts.body) opts.headers = { 'Content-Type': 'application/json' };
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (r.status === 401 && url.indexOf('/login') === -1) { showLogin(); throw new Error('נדרשת התחברות'); }
        if (!r.ok) throw new Error(body.error || 'אירעה שגיאה');
        return body;
      });
    });
  }

  // Not logged in: go to the guest page, which opens the login window (there is no separate login page).
  function showLogin() {
    $('dashView').hidden = true;
    $('loginView').hidden = false;
    $('username').focus();
  }
  function showDash() { $('loginView').hidden = true; $('dashView').hidden = false; }

  function load() {
    return api('/api/admin/responses').then(function (data) {
      state.responses = data.responses;
      $('sTotal').textContent = data.summary.totalPeople;
      $('sYes').textContent = data.summary.yes;
      $('sNo').textContent = data.summary.no;
      $('sMaybe').textContent = data.summary.maybe;
      $('sResponses').textContent = data.summary.responses;
      $('sYes2').textContent = data.summary.yes;
      $('sCompanions').textContent = data.summary.companions;
      $('sTotal2').textContent = data.summary.totalPeople;
      $('sChanged').textContent = data.summary.changed;
      renderSizes(data.summary.bySize);
      var f = $('eventForm');
      if (!f.contains(document.activeElement)) {
        f.childName.value = data.event.childName;
        f.eventDate.value = data.event.eventDate;
        f.eventLocation.value = data.event.eventLocation;
      }
      showDash();
      $('loadError').textContent = '';
      render();
    });
  }

  function renderSizes(bySize) {
    var tbody = $('sizeRows');
    tbody.textContent = '';
    var sizes = Object.keys(bySize).map(Number).sort(function (a, b) { return a - b; });
    sizes.forEach(function (n) {
      var tr = document.createElement('tr');
      tr.appendChild(cell(sizeLabel(n) + ' (' + n + ')'));
      tr.appendChild(cell(bySize[n]));
      tr.appendChild(cell(n * bySize[n]));
      tbody.appendChild(tr);
    });
    $('sizeEmpty').hidden = sizes.length > 0;
  }

  function describeAnswer(r) {
    return r.status === 'yes' ? LABELS.yes + ' (' + r.people + ')' : LABELS[r.status];
  }

  function cell(text) { var td = document.createElement('td'); td.textContent = text; return td; }

  function render() {
    var list = state.responses.filter(function (r) {
      if (state.filter === 'changed') return r.history && r.history.length > 0;
      return !state.filter || r.status === state.filter;
    });
    var tbody = $('rows');
    tbody.textContent = '';
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.appendChild(cell(r.firstName));
      tr.appendChild(cell(r.lastName || '—'));
      var st = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'badge ' + r.status;
      badge.textContent = LABELS[r.status];
      st.appendChild(badge);
      st.className = 'answer';
      // Earlier answers, most recent first, so the organizer sees what changed.
      (r.history || []).slice().reverse().forEach(function (h) {
        var prev = document.createElement('div');
        prev.className = 'prev';
        prev.textContent = 'קודם: ' + describeAnswer(h) + ' · שונה ב־' + timeFmt.format(new Date(h.changedAt)) +
          (h.changedBy === 'admin' ? ' (על ידי המנהל)' : '');
        st.appendChild(prev);
      });
      tr.appendChild(st);
      if (r.history && r.history.length) tr.className = 'changed';
      tr.appendChild(cell(r.status === 'yes' ? r.people + ' (' + sizeLabel(r.people) + ')' : '—'));
      tr.appendChild(cell(timeFmt.format(new Date(r.createdAt))));
      tr.appendChild(cell(r.updatedAt ? timeFmt.format(new Date(r.updatedAt)) : '—'));
      var actions = document.createElement('td');
      actions.className = 'actions';
      var edit = document.createElement('button');
      edit.className = 'btn small'; edit.type = 'button'; edit.textContent = 'עריכה';
      edit.onclick = function () { openEdit(r); };
      var del = document.createElement('button');
      del.className = 'btn small danger'; del.type = 'button'; del.textContent = 'מחיקה';
      del.onclick = function () { remove(r); };
      actions.appendChild(edit); actions.appendChild(del);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    $('empty').hidden = list.length > 0;
    $('countNote').textContent = list.length + ' תשובות';
    $('csvLink').href = '/api/admin/export.csv' + (state.filter ? '?status=' + state.filter : '');
  }

  function openEdit(r) {
    state.editing = r;
    $('editName').value = r.firstName;
    $('editLastName').value = r.lastName || '';
    $('editStatus').value = r.status;
    $('editPeople').value = String(r.people || 1);
    $('editPeopleField').hidden = r.status !== 'yes';
    $('editError').textContent = '';
    $('editDialog').showModal();
  }

  function remove(r) {
    if (!confirm('למחוק את התשובה של ' + (r.firstName + ' ' + (r.lastName || '')).trim() + '?')) return;
    api('/api/admin/responses/' + r.id, { method: 'DELETE' }).then(load).catch(function (e) { alert(e.message); });
  }

  $('editStatus').addEventListener('change', function () { $('editPeopleField').hidden = this.value !== 'yes'; });
  $('editCancel').addEventListener('click', function () { $('editDialog').close(); });
  $('editForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var status = $('editStatus').value;
    var people = Number($('editPeople').value);
    if (status === 'yes' && (!Number.isInteger(people) || people < 1 || people > 30)) {
      $('editError').textContent = 'נא לכתוב מספר אנשים בין 1 ל־30';
      return;
    }
    api('/api/admin/responses/' + state.editing.id, {
      method: 'PUT',
      body: JSON.stringify({ firstName: $('editName').value, lastName: $('editLastName').value, status: status, people: status === 'yes' ? people : 0 })
    })
      .then(function () { $('editDialog').close(); return load(); })
      .catch(function (err) { $('editError').textContent = err.message; });
  });

  $('filter').addEventListener('change', function () { state.filter = this.value; render(); });
  $('refreshBtn').addEventListener('click', function () { load().catch(function () {}); });
  $('logoutBtn').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).finally(function () { $('password').value = ''; showLogin(); });
  });

  $('eventForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    api('/api/admin/event', {
      method: 'PUT',
      body: JSON.stringify({ childName: f.childName.value, eventDate: f.eventDate.value, eventLocation: f.eventLocation.value })
    })
      .then(function () { $('eventSaved').textContent = 'נשמר ✓'; setTimeout(function () { $('eventSaved').textContent = ''; }, 2500); })
      .catch(function (err) { $('eventSaved').textContent = err.message; });
  });

  // Keep the numbers fresh while the page is open.
  setInterval(function () { if (!$('dashView').hidden && !$('editDialog').open) load().catch(function () {}); }, 30000);

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('loginError').textContent = '';
    $('loginSubmit').disabled = true;
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: $('username').value, password: $('password').value }) })
      .then(function () { $('password').value = ''; return load(); })
      .catch(function (err) { $('loginError').textContent = err.message; })
      .finally(function () { $('loginSubmit').disabled = false; });
  });
  $('loginForm').addEventListener('input', function () { $('loginError').textContent = ''; });

  load()
    .catch(function (err) {
      if (err.message === 'נדרשת התחברות') return;
      showDash();
      $('loadError').textContent = err.message;
    });
})();
