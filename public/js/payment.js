/* Receive-payment form: student search picker + live allocation preview (integer cents only). */
(function () {
  'use strict';
  const form = document.getElementById('paymentForm');
  const search = document.getElementById('studentSearch');
  const results = document.getElementById('studentResults');

  if (search && results) {
    let timer;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const res = await fetch(`/school/students/search?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const items = await res.json();
        results.innerHTML = '';
        if (!items.length) { results.innerHTML = '<div class="list-group-item text-muted small">No students found</div>'; return; }
        items.forEach((s) => {
          const a = document.createElement('a');
          a.className = 'list-group-item list-group-item-action d-flex justify-content-between';
          a.href = `/school/finance/payments/new?student=${encodeURIComponent(s.id)}`;
          const left = document.createElement('span');
          left.textContent = `${s.name} · ${s.code}`;
          const right = document.createElement('small');
          right.className = 'text-muted';
          right.textContent = s.className || '';
          a.append(left, right);
          results.appendChild(a);
        });
      }, 250);
    });
  }

  if (!form) return;
  const amount = form.querySelector('input[name="amount"]');
  const boxes = Array.from(form.querySelectorAll('input[name="invoices"]'));
  const preview = document.getElementById('allocationPreview');
  const cur = form.dataset.currency || 'USD';
  const toCents = (s) => {
    const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(String(s || '').trim());
    if (!m) return null;
    return Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
  };
  const fmt = (c) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(c / 100); } catch (e) { return (c / 100).toFixed(2); } };

  function selected() {
    const chosen = boxes.filter((b) => b.checked);
    return (chosen.length ? chosen : boxes).map((b) => ({ no: b.dataset.no, due: Number(b.dataset.due) }));
  }

  function render() {
    const cents = toCents(amount.value);
    const invs = selected();
    const due = invs.reduce((a, i) => a + i.due, 0);
    if (!preview) return;
    if (cents === null || cents <= 0) { preview.innerHTML = `<span class="text-muted">Outstanding on selected invoices: <strong>${fmt(due)}</strong></span>`; return; }
    if (cents > due) { preview.innerHTML = `<span class="text-danger">Amount exceeds the outstanding ${fmt(due)}.</span>`; return; }
    let left = cents;
    const lines = invs.map((i) => { const a = Math.min(left, i.due); left -= a; return a > 0 ? `<li>${i.no}: ${fmt(a)}${a < i.due ? ` <span class="text-muted">(partial, ${fmt(i.due - a)} left)</span>` : ' <span class="text-success">paid in full</span>'}</li>` : ''; }).join('');
    preview.innerHTML = `<div class="small-caps mb-1">Allocation</div><ul class="mb-0 ps-3">${lines}</ul><div class="mt-1">Remaining on selected invoices after payment: <strong>${fmt(due - cents)}</strong></div>`;
  }
  amount && amount.addEventListener('input', render);
  boxes.forEach((b) => b.addEventListener('change', render));
  const fill = document.getElementById('fillDue');
  fill && fill.addEventListener('click', () => {
    const due = selected().reduce((a, i) => a + i.due, 0);
    amount.value = (due / 100).toFixed(2);
    render();
  });
  render();
})();
