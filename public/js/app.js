/* Quranic — shared client-side behaviour (CSP-safe: no inline scripts or handlers). */
(function () {
  'use strict';

  /* ---- Sidebar toggle (mobile) ---- */
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.querySelector('.sidebar-backdrop');
  document.querySelectorAll('[data-toggle-sidebar]').forEach((btn) => btn.addEventListener('click', () => {
    sidebar && sidebar.classList.toggle('show');
    backdrop && backdrop.classList.toggle('show');
  }));
  backdrop && backdrop.addEventListener('click', () => { sidebar.classList.remove('show'); backdrop.classList.remove('show'); });

  /* ---- Confirmation dialogs for sensitive actions ----
     <form data-confirm="Message" data-confirm-reason="true"> ... */
  const modalEl = document.getElementById('confirmModal');
  let pendingForm = null;
  if (modalEl && window.bootstrap) {
    const modal = new bootstrap.Modal(modalEl);
    const reasonWrap = modalEl.querySelector('[data-reason-wrap]');
    const reasonInput = modalEl.querySelector('textarea');
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!form.matches('form[data-confirm]') || form.dataset.confirmed === '1') return;
      e.preventDefault();
      pendingForm = form;
      modalEl.querySelector('[data-confirm-text]').textContent = form.dataset.confirm;
      modalEl.querySelector('[data-confirm-title]').textContent = form.dataset.confirmTitle || 'Please confirm';
      const needsReason = form.dataset.confirmReason === 'true';
      reasonWrap.classList.toggle('d-none', !needsReason);
      reasonInput.value = '';
      reasonInput.required = needsReason;
      const okBtn = modalEl.querySelector('[data-confirm-ok]');
      okBtn.className = `btn ${form.dataset.confirmVariant || 'btn-danger'}`;
      okBtn.textContent = form.dataset.confirmButton || 'Confirm';
      modal.show();
      if (needsReason) setTimeout(() => reasonInput.focus(), 300);
    });
    modalEl.querySelector('[data-confirm-ok]').addEventListener('click', () => {
      if (!pendingForm) return;
      if (reasonInput.required && reasonInput.value.trim().length < 3) { reasonInput.classList.add('is-invalid'); return; }
      reasonInput.classList.remove('is-invalid');
      if (reasonInput.required) {
        let hidden = pendingForm.querySelector('input[name="reason"]');
        if (!hidden) { hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'reason'; pendingForm.appendChild(hidden); }
        hidden.value = reasonInput.value.trim();
      }
      pendingForm.dataset.confirmed = '1';
      modal.hide();
      pendingForm.requestSubmit ? pendingForm.requestSubmit() : pendingForm.submit();
    });
  }

  /* ---- Client-side form validation (Bootstrap styles) ---- */
  document.querySelectorAll('form.needs-validation').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!form.checkValidity()) { e.preventDefault(); e.stopPropagation(); }
      form.classList.add('was-validated');
    });
  });

  /* ---- Prevent double submits ---- */
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || form.dataset.confirm && form.dataset.confirmed !== '1') return;
    const btn = form.querySelector('button[type="submit"]:not([data-keep])');
    if (btn) setTimeout(() => { btn.disabled = true; btn.dataset.originalText = btn.innerHTML; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Working…'; }, 0);
  });

  /* ---- Auto-submit filters ---- */
  document.querySelectorAll('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

  /* ---- Print buttons ---- */
  document.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));

  /* ---- Image preview for file inputs ---- */
  document.querySelectorAll('input[type=file][data-preview]').forEach((input) => {
    input.addEventListener('change', () => {
      const img = document.querySelector(input.dataset.preview);
      const f = input.files && input.files[0];
      if (img && f && f.type.startsWith('image/')) { img.src = URL.createObjectURL(f); img.classList.remove('d-none'); }
    });
  });

  /* ---- Attendance: "mark all" ---- */
  document.querySelectorAll('[data-mark-all]').forEach((b) => b.addEventListener('click', () => {
    const status = b.dataset.markAll;
    document.querySelectorAll(`input[type=radio][value="${status}"]`).forEach((r) => { r.checked = true; });
  }));

  /* ---- Select-all checkboxes ---- */
  document.querySelectorAll('[data-check-all]').forEach((master) => master.addEventListener('change', () => {
    document.querySelectorAll(master.dataset.checkAll).forEach((c) => { c.checked = master.checked; });
  }));

  /* ---- Surah -> verse limit ---- */
  const surah = document.querySelector('select[name="surah"]');
  if (surah) {
    const sync = () => {
      const opt = surah.selectedOptions[0];
      const max = opt && opt.dataset.verses ? Number(opt.dataset.verses) : null;
      ['fromVerse', 'toVerse'].forEach((n) => {
        const el = document.querySelector(`input[name="${n}"]`);
        if (!el) return;
        if (max) { el.max = max; el.placeholder = `1 – ${max}`; } else { el.removeAttribute('max'); el.placeholder = ''; }
      });
    };
    surah.addEventListener('change', sync); sync();
  }

  /* ---- Plan billing cycle -> custom days ---- */
  const cycle = document.querySelector('select[name="billingCycle"]');
  if (cycle) {
    const wrap = document.querySelector('[data-custom-days]');
    const sync = () => wrap && wrap.classList.toggle('d-none', cycle.value !== 'custom');
    cycle.addEventListener('change', sync); sync();
  }

  /* ---- Invoice type -> period field ---- */
  const invType = document.querySelector('select[name="type"][data-invoice-type]');
  if (invType) {
    const wrap = document.querySelector('[data-period-wrap]');
    const sync = () => wrap && wrap.classList.toggle('d-none', invType.value !== 'monthly');
    invType.addEventListener('change', sync); sync();
  }

  /* ---- Role -> teacher profile field ---- */
  document.querySelectorAll('select[name="role"][data-role-select]').forEach((sel) => {
    const wrap = sel.closest('form').querySelector('[data-teacher-wrap]');
    const sync = () => wrap && wrap.classList.toggle('d-none', sel.value !== 'teacher');
    sel.addEventListener('change', sync); sync();
  });

  /* ---- Recurring expense toggle ---- */
  const rec = document.querySelector('input[name="recurring"]');
  if (rec) {
    const wrap = document.querySelector('[data-frequency-wrap]');
    const sync = () => wrap && wrap.classList.toggle('d-none', !rec.checked);
    rec.addEventListener('change', sync); sync();
  }
})();
