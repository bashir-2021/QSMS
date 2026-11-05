/* Subac scoring: + and - buttons and a live score. The server recalculates the score when saved. */
(function () {
  'use strict';

  const round = (n) => Math.round(n * 100) / 100;

  document.querySelectorAll('[data-subac-row]').forEach((row) => {
    const base = Number(row.dataset.base);
    const attendance = row.querySelector('[data-subac-attendance]');
    const inputs = row.querySelector('[data-subac-inputs]');
    const scoreEl = row.querySelector('[data-subac-score]');
    const counts = [...row.querySelectorAll('input[data-rate]')];
    const manual = row.querySelector('input[data-manual]');

    function refresh() {
      const scored = ['present', 'late'].includes(attendance.value);
      inputs.classList.toggle('opacity-50', !scored);
      if (!scored) { scoreEl.textContent = '—'; return; }
      const deducted = counts.reduce((sum, el) => sum + (Number(el.value) || 0) * Number(el.dataset.rate), 0);
      scoreEl.textContent = Math.max(0, Math.min(base, round(base - deducted + (Number(manual.value) || 0))));
    }

    row.addEventListener('click', (e) => {
      const button = e.target.closest('[data-step]');
      if (!button) return;
      const input = button.parentElement.querySelector('input');
      const next = round((Number(input.value) || 0) + Number(button.dataset.step));
      input.value = Math.max(Number(input.min), Math.min(Number(input.max), next));
      refresh();
    });
    row.addEventListener('input', refresh);
    row.addEventListener('change', refresh);
    refresh();
  });
}());
