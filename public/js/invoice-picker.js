/* Student picker for the new-invoice page: links to the invoice form for the chosen student. */
(function () {
  'use strict';
  const input = document.getElementById('studentSearch');
  const list = document.getElementById('studentResults');
  if (!input || !list) return;
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const res = await fetch(`/school/students/search?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const items = await res.json();
      list.innerHTML = '';
      items.forEach((s) => {
        const a = document.createElement('a');
        a.className = 'list-group-item list-group-item-action';
        a.href = `/school/finance/invoices/new?student=${encodeURIComponent(s.id)}`;
        a.textContent = `${s.name} · ${s.code}${s.className ? ` · ${s.className}` : ''}`;
        list.appendChild(a);
      });
      if (!items.length) list.innerHTML = '<div class="list-group-item text-muted small">No students found</div>';
    }, 250);
  });
})();
