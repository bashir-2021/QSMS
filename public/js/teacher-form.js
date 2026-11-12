/* Teacher form: show how many working days are ticked. */
(function () {
  'use strict';
  const box = document.querySelector('[data-work-days]');
  const out = document.querySelector('[data-day-count]');
  const text = document.getElementById('dayCountText');
  if (!box || !out || !text) return;
  const update = () => {
    out.textContent = text.dataset.text.replace('{n}', box.querySelectorAll('input:checked').length);
  };
  box.addEventListener('change', update);
  update();
}());
