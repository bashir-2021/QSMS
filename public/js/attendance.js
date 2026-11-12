/* Student register: each row's Save button saves only that student without reloading the page.
   Without JavaScript the same button submits the form with only=<student>, so it still works. */
(function () {
  'use strict';
  const form = document.querySelector('[data-att-register]');
  if (!form || !window.fetch) return;
  const text = document.getElementById('attText').dataset;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function updateCount() {
    const badge = form.querySelector('[data-att-count]');
    const rows = form.querySelectorAll('[data-att-row]');
    const unsaved = form.querySelectorAll('[data-att-row].att-unsaved').length;
    if (!badge) return;
    const done = rows.length - unsaved;
    badge.textContent = unsaved ? text.of.replace('{n}', done).replace('{total}', rows.length) : text.all;
    badge.className = `badge ms-1 ${unsaved ? 'badge-soft-warning' : 'badge-soft-success'}`;
  }

  form.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-att-save]');
    if (!button) return;
    e.preventDefault();
    const id = button.value;
    const row = form.querySelector(`[data-att-row="${id}"]`);
    const cell = row.querySelector('[data-att-who]');
    const body = new URLSearchParams(new FormData(form));
    body.set('only', id);
    button.disabled = true;
    try {
      const res = await fetch(form.action, { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || text.failed);
      const info = data.rows[id];
      if (info) {
        cell.innerHTML = `<span class="badge badge-soft-success"><i class="bi bi-check2"></i> ${esc(text.saved)}</span><div class="text-muted">${esc(info.by || '—')} · ${esc(info.at)}</div>`;
        row.classList.remove('att-unsaved', 'att-changed');
        row.classList.add('att-just-saved');
        setTimeout(() => row.classList.remove('att-just-saved'), 1500);
      }
      updateCount();
    } catch (err) {
      cell.innerHTML = `<span class="text-danger">${esc(err.message || text.failed)}</span>`;
    } finally {
      button.disabled = false;
    }
  });

  // a row whose choice changed after it was saved shows as not saved until it is saved again
  form.addEventListener('change', (e) => {
    const row = e.target.closest('[data-att-row]');
    if (row) row.classList.add('att-changed');
  });
}());
