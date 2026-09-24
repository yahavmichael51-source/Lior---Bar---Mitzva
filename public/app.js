(function () {
  var form = document.getElementById('rsvpForm');
  var peopleField = document.getElementById('peopleField');
  var errorEl = document.getElementById('error');
  var submitBtn = document.getElementById('submitBtn');

  function el(tag, text, bold) {
    var span = document.createElement(tag);
    if (bold) {
      var b = document.createElement('b');
      b.textContent = bold;
      span.appendChild(b);
      span.appendChild(document.createTextNode(' ' + text));
    } else span.textContent = text;
    return span;
  }

  fetch('/api/event')
    .then(function (r) { return r.json(); })
    .then(function (ev) {
      if (ev.childName) {
        document.getElementById('childName').textContent = ev.childName;
        document.title = 'אישור הגעה לבר המצווה של ' + ev.childName;
      }
      var meta = document.getElementById('meta');
      if (ev.eventDate) meta.appendChild(el('span', ev.eventDate, 'מתי:'));
      if (ev.eventLocation) meta.appendChild(el('span', ev.eventLocation, 'איפה:'));
    })
    .catch(function () {});

  function selected(name) {
    var input = form.querySelector('input[name="' + name + '"]:checked');
    return input ? input.value : null;
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'status') {
      var coming = e.target.value === 'yes';
      peopleField.hidden = !coming;
      if (!coming) form.querySelectorAll('input[name="people"]').forEach(function (i) { i.checked = false; });
    }
  });

  // Clear the error while the guest types/chooses (not on blur, which would shift the button mid-tap).
  form.addEventListener('input', function () { errorEl.textContent = ''; });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var firstName = form.firstName.value.trim();
    var status = selected('status');
    var people = selected('people');

    if (!firstName) { errorEl.textContent = 'נא לכתוב שם פרטי'; form.firstName.focus(); return; }
    if (!status) { errorEl.textContent = 'נא לבחור אחת מהתשובות'; return; }
    if (status === 'yes' && !people) { errorEl.textContent = 'נא לבחור כמה אנשים יגיעו'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'שולח…';
    errorEl.textContent = '';

    fetch('/api/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: firstName, status: status, people: status === 'yes' ? Number(people) : 0 })
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || 'error');
        var text = {
          yes: 'התשובה שלך נשמרה. מחכים לראות אותך!',
          no: 'התשובה שלך נשמרה. חבל שלא תוכל/י להגיע.',
          maybe: 'התשובה שלך נשמרה. אפשר לשלוח תשובה מעודכנת כשתדע/י.'
        }[status];
        document.getElementById('thanksTitle').textContent = 'תודה, ' + firstName + '!';
        document.getElementById('thanksText').textContent = text;
        document.getElementById('formCard').hidden = true;
        document.getElementById('thanksCard').hidden = false;
        window.scrollTo(0, 0);
      })
      .catch(function (err) {
        errorEl.textContent = err.message && err.message !== 'error' && err.message !== 'Failed to fetch'
          ? err.message
          : 'לא הצלחנו לשמור את התשובה. בדקו את החיבור לאינטרנט ונסו שוב.';
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'שליחת תשובה';
      });
  });

  document.getElementById('againBtn').addEventListener('click', function () {
    form.reset();
    peopleField.hidden = true;
    document.getElementById('thanksCard').hidden = true;
    document.getElementById('formCard').hidden = false;
    form.firstName.focus();
  });
})();
