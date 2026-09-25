(function () {
  var LABELS = { yes: 'מגיע/ה', no: 'לא מגיע/ה', maybe: 'עוד לא יודע/ת' };
  var STORAGE_KEY = 'rsvp-mine'; // answers sent from this phone: [{ id, token }]
  var $ = function (id) { return document.getElementById(id); };

  var form = $('rsvpForm');
  var peopleField = $('peopleField');
  var otherField = $('otherField');
  var otherCount = $('otherCount');
  var errorEl = $('error');
  var submitBtn = $('submitBtn');

  var editing = null; // { id, token } while changing an existing answer
  var lastSaved = null; // { id, token } of the answer just sent
  var mine = []; // [{ id, token, response }] loaded from the server

  // ---------- local storage of this phone's answers (never required for the site to work) ----------
  function readSaved() {
    try {
      var list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(list) ? list.filter(function (x) { return x && x.id && x.token; }) : [];
    } catch (e) { return []; }
  }
  function writeSaved(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(-10))); } catch (e) {}
  }
  function remember(id, token) {
    var list = readSaved().filter(function (x) { return x.id !== id; });
    list.push({ id: id, token: token });
    writeSaved(list);
  }

  function request(method, url, token, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Edit-Token'] = token;
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
      });
  }

  // ---------- event details ----------
  function metaLine(label, text) {
    var span = document.createElement('span');
    var b = document.createElement('b');
    b.textContent = label;
    span.appendChild(b);
    span.appendChild(document.createTextNode(' ' + text));
    return span;
  }

  request('GET', '/api/event')
    .then(function (res) {
      var ev = res.body;
      if (ev.childName) {
        $('childName').textContent = ev.childName;
        document.title = 'אישור הגעה לבר המצווה של ' + ev.childName;
      }
      if (ev.eventDate) $('meta').appendChild(metaLine('מתי:', ev.eventDate));
      if (ev.eventLocation) $('meta').appendChild(metaLine('איפה:', ev.eventLocation));
    })
    .catch(function () {});

  // ---------- screens ----------
  function show(which) {
    $('mineCard').hidden = which !== 'mine';
    $('formCard').hidden = which !== 'form';
    $('thanksCard').hidden = which !== 'thanks';
    window.scrollTo(0, 0);
  }

  function describe(r) {
    if (r.status !== 'yes') return LABELS[r.status];
    return LABELS.yes + ' · ' + (r.people === 1 ? 'רק אני' : r.people + ' אנשים');
  }

  function renderMine() {
    var ul = $('mineList');
    ul.textContent = '';
    mine.forEach(function (m) {
      var li = document.createElement('li');
      var info = document.createElement('div');
      var who = document.createElement('div');
      who.className = 'who';
      who.textContent = (m.response.firstName + ' ' + (m.response.lastName || '')).trim();
      var what = document.createElement('div');
      what.className = 'what';
      what.textContent = describe(m.response);
      info.appendChild(who);
      info.appendChild(what);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn small primary';
      btn.textContent = 'שינוי תשובה';
      btn.onclick = function () { startEdit(m); };
      li.appendChild(info);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  // Load this phone's earlier answers from the server (drops ones the organizer deleted).
  function loadMine() {
    var saved = readSaved();
    if (!saved.length) return Promise.resolve([]);
    return Promise.all(saved.map(function (s) {
      return request('GET', '/api/rsvp/' + encodeURIComponent(s.id), s.token)
        .then(function (res) {
          if (res.ok) return { id: s.id, token: s.token, response: res.body.response };
          return res.status === 404 ? null : { id: s.id, token: s.token, keep: true };
        })
        .catch(function () { return { id: s.id, token: s.token, keep: true }; });
    })).then(function (results) {
      writeSaved(results.filter(Boolean).map(function (x) { return { id: x.id, token: x.token }; }));
      mine = results.filter(function (x) { return x && x.response; });
      return mine;
    });
  }

  // ---------- form ----------
  function resetForm() {
    form.reset();
    peopleField.hidden = true;
    otherField.hidden = true;
    errorEl.textContent = '';
  }

  function startNew() {
    editing = null;
    resetForm();
    $('editingBanner').hidden = true;
    submitBtn.textContent = 'שליחת תשובה';
    show('form');
    form.firstName.focus();
  }

  function startEdit(m) {
    editing = { id: m.id, token: m.token };
    resetForm();
    var r = m.response;
    form.firstName.value = r.firstName;
    form.lastName.value = r.lastName || '';
    form.querySelector('input[name="status"][value="' + r.status + '"]').checked = true;
    if (r.status === 'yes') {
      peopleField.hidden = false;
      var preset = form.querySelector('input[name="people"][value="' + r.people + '"]');
      if (preset) preset.checked = true;
      else {
        form.querySelector('input[name="people"][value="other"]').checked = true;
        otherField.hidden = false;
        otherCount.value = r.people;
      }
    }
    $('editingText').textContent = 'עדכון התשובה של ' + r.firstName;
    $('editingBanner').hidden = false;
    submitBtn.textContent = 'עדכון התשובה';
    show('form');
  }

  function selected(name) {
    var input = form.querySelector('input[name="' + name + '"]:checked');
    return input ? input.value : null;
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'status') {
      var coming = e.target.value === 'yes';
      peopleField.hidden = !coming;
      if (!coming) {
        form.querySelectorAll('input[name="people"]').forEach(function (i) { i.checked = false; });
        otherField.hidden = true;
        otherCount.value = '';
      }
    }
    if (e.target.name === 'people') {
      otherField.hidden = e.target.value !== 'other';
      if (e.target.value === 'other') otherCount.focus();
    }
  });

  // Clear the error while the guest types/chooses (not on blur, which would shift the button mid-tap).
  form.addEventListener('input', function () { errorEl.textContent = ''; });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var firstName = form.firstName.value.trim();
    var lastName = form.lastName.value.trim();
    var status = selected('status');
    var people = selected('people');

    if (!firstName) { errorEl.textContent = 'נא לכתוב שם פרטי'; form.firstName.focus(); return; }
    if (!lastName) { errorEl.textContent = 'נא לכתוב שם משפחה'; form.lastName.focus(); return; }
    if (!status) { errorEl.textContent = 'נא לבחור אחת מהתשובות'; return; }
    if (status === 'yes' && !people) { errorEl.textContent = 'נא לבחור כמה אנשים יגיעו'; return; }
    if (status === 'yes' && people === 'other') {
      var n = Number(otherCount.value);
      if (!otherCount.value || !Number.isInteger(n) || n < 1 || n > 30) {
        errorEl.textContent = 'נא לכתוב כמה אנשים יגיעו בסך הכול (מספר בין 1 ל־30)';
        otherCount.focus();
        return;
      }
      people = String(n);
    }

    var label = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'שולח…';
    errorEl.textContent = '';

    var payload = { firstName: firstName, lastName: lastName, status: status, people: status === 'yes' ? Number(people) : 0 };
    var wasEditing = editing;
    var call = wasEditing
      ? request('PUT', '/api/rsvp/' + encodeURIComponent(wasEditing.id), wasEditing.token, payload)
      : request('POST', '/api/rsvp', null, payload);

    call
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'error');
        if (wasEditing) lastSaved = wasEditing;
        else {
          lastSaved = { id: res.body.response.id, token: res.body.editToken };
          remember(lastSaved.id, lastSaved.token);
        }
        editing = null;
        var text = {
          yes: 'מחכים לראות אותך!',
          no: 'חבל שלא תוכל/י להגיע.',
          maybe: 'אפשר לחזור ולעדכן כשתדע/י.'
        }[status];
        $('thanksTitle').textContent = 'תודה, ' + firstName + '!';
        $('thanksText').textContent = (wasEditing ? 'התשובה עודכנה. ' : 'התשובה שלך נשמרה. ') + text;
        show('thanks');
      })
      .catch(function (err) {
        errorEl.textContent = err.message && err.message !== 'error' && err.message !== 'Failed to fetch'
          ? err.message
          : 'לא הצלחנו לשמור את התשובה. בדקו את החיבור לאינטרנט ונסו שוב.';
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = label;
      });
  });

  $('changeBtn').addEventListener('click', function () {
    if (!lastSaved) return startNew();
    request('GET', '/api/rsvp/' + encodeURIComponent(lastSaved.id), lastSaved.token).then(function (res) {
      if (res.ok) startEdit({ id: lastSaved.id, token: lastSaved.token, response: res.body.response });
      else startNew();
    }).catch(startNew);
  });
  $('againBtn').addEventListener('click', startNew);
  $('newForOther').addEventListener('click', startNew);
  $('cancelEdit').addEventListener('click', function () {
    editing = null;
    loadMine().then(function (list) { if (list.length) { renderMine(); show('mine'); } else startNew(); });
  });

  // On open: if this phone already answered, show those answers with a "change" button.
  loadMine().then(function (list) {
    if (list.length) { renderMine(); show('mine'); }
  });
})();
