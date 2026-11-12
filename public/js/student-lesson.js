/*
 * Student lesson forms.
 *  - Give a lesson: shows the size of the portion (ayahs, Mushaf pages, juz) as the teacher picks it.
 *  - Listen to a lesson: follows the chain attendance -> lesson status -> warnings -> score -> level -> result;
 *    fields that do not apply are disabled (so they are not sent) and the outcome is previewed as the teacher types.
 * The server recalculates everything when the form is saved (services/studentLessonService.js evaluate()).
 */
(function () {
  'use strict';

  const form = document.querySelector('[data-lesson-form]');
  const cfgEl = document.getElementById('lessonConfig');
  if (!form || !cfgEl) return;
  const cfg = JSON.parse(cfgEl.textContent);
  const rules = cfg.rules;
  const lowest = rules.levels[rules.levels.length - 1].label;
  const round2 = (n) => Math.round(n * 100) / 100;
  const $ = (sel) => form.querySelector(sel);
  const $$ = (sel) => [...form.querySelectorAll(sel)];

  const warnings = $('[data-warnings]');
  const reasonBox = $('[data-reason-box]');
  const reason = $('[data-reason]');
  const out = { score: $('[data-out-score]'), level: $('[data-out-level]'), result: $('[data-out-result]') };
  const absentNote = $('[data-absent-note]');
  const sizeEl = $('[data-portion-size]');

  const checkedValue = (name) => { const el = $(`input[name="${name}"]:checked`); return el ? el.value : null; };
  const badge = (color, text) => `<span class="badge badge-soft-${color}">${text}</span>`;
  const setOut = (score, level, result) => {
    out.score.textContent = score;
    out.level.textContent = level;
    out.result.innerHTML = result;
  };
  const enable = (els, on) => els.forEach((el) => {
    el.disabled = !on;
    const wrap = el.closest('.col-md-4, .col-md-5, .col-md-7, .col-md-8, .col-12');
    if (wrap) wrap.classList.toggle('opacity-50', !on);
  });

  /* ------------------------------- Mushaf size ------------------------------ */
  const m = cfg.mushaf;
  const lastAtOrBefore = (list, id) => {
    let lo = 0; let hi = list.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (list[mid] <= id) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const ayahId = (surah, ayah) => {
    const s = Number(surah); const a = Number(ayah);
    if (!m || !(s >= 1 && s <= 114) || !(Number.isInteger(a) && a >= 1 && a <= m.verses[s - 1])) return null;
    return m.surahStarts[s - 1] + a - 1;
  };
  // ayah weights by page area, as in utils/quran.js measure()
  let weights = null;
  function pageWeights() {
    if (weights) return weights;
    weights = new Float64Array(6237);
    for (let id = 1; id <= 6236; id += 1) {
      const p = lastAtOrBefore(m.pageStarts, id);
      const next = p + 1 < m.pageStarts.length ? m.pageStarts[p + 1] : 6237;
      weights[id] = weights[id - 1] + 1 / (next - m.pageStarts[p]);
    }
    return weights;
  }
  function measure(from, to) {
    const w = pageWeights();
    const juzLast = (j) => (j < 30 ? m.juzStarts[j] - 1 : 6236);
    const startJuz = lastAtOrBefore(m.juzStarts, from) + 1;
    const endJuz = lastAtOrBefore(m.juzStarts, to) + 1;
    let juz = 0;
    for (let j = startJuz; j <= endJuz; j += 1) {
      const first = Math.max(from, m.juzStarts[j - 1]);
      const last = Math.min(to, juzLast(j));
      juz += (w[last] - w[first - 1]) / (w[juzLast(j)] - w[m.juzStarts[j - 1] - 1]);
    }
    const startPage = lastAtOrBefore(m.pageStarts, from) + 1;
    const endPage = lastAtOrBefore(m.pageStarts, to) + 1;
    return { ayahs: to - from + 1, from: startPage, to: endPage, pages: endPage - startPage + 1, juz: round2(juz) };
  }
  const fill = (tpl, v) => tpl.replace(/\{(\w+)\}/g, (x, k) => (v[k] === undefined ? x : v[k]));

  function refreshSize() {
    if (!sizeEl || !m) return;
    const from = ayahId($('[data-surah="start"]').value, $('[data-ayah="start"]').value);
    const to = ayahId($('[data-surah="end"]').value, $('[data-ayah="end"]').value);
    if (!from || !to) { sizeEl.textContent = ''; sizeEl.classList.remove('text-danger'); return; }
    if (to < from) { sizeEl.textContent = cfg.text.invalid; sizeEl.classList.add('text-danger'); return; }
    sizeEl.classList.remove('text-danger');
    sizeEl.textContent = fill(cfg.text.size, measure(from, to));
  }

  function limitAyah(which) {
    const surah = $(`[data-surah="${which}"]`);
    const ayah = $(`[data-ayah="${which}"]`);
    if (!surah || !ayah) return;
    const opt = surah.selectedOptions[0];
    const verses = opt && opt.dataset.verses ? Number(opt.dataset.verses) : null;
    if (verses) {
      ayah.max = verses;
      if (Number(ayah.value) > verses) ayah.value = verses;
    } else ayah.removeAttribute('max');
  }

  const juzFill = $('[data-juz-fill]');
  if (juzFill && m) {
    juzFill.addEventListener('change', () => {
      const j = Number(juzFill.value);
      if (!j) return;
      const from = m.juzStarts[j - 1];
      const to = j < 30 ? m.juzStarts[j] - 1 : 6236;
      const ref = (id) => { const s = lastAtOrBefore(m.surahStarts, id); return { surah: s + 1, ayah: id - m.surahStarts[s] + 1 }; };
      const a = ref(from); const b = ref(to);
      $('[data-surah="start"]').value = a.surah; $('[data-ayah="start"]').value = a.ayah;
      $('[data-surah="end"]').value = b.surah; $('[data-ayah="end"]').value = b.ayah;
      limitAyah('start'); limitAyah('end'); refreshSize();
    });
  }
  ['start', 'end'].forEach((which) => {
    const surah = $(`[data-surah="${which}"]`);
    if (!surah) return;
    surah.addEventListener('change', () => {
      limitAyah(which);
      // a new start surah usually means the lesson ends in the same surah
      if (which === 'start' && !$('[data-surah="end"]').value) { $('[data-surah="end"]').value = surah.value; limitAyah('end'); }
      if (juzFill) juzFill.value = '';
      refreshSize();
    });
    $(`[data-ayah="${which}"]`).addEventListener('input', () => { if (juzFill) juzFill.value = ''; refreshSize(); });
  });

  /* ------------------------------ Scoring chain ----------------------------- */
  if (!warnings) { limitAyah('start'); limitAyah('end'); refreshSize(); return; } // giving a lesson: no scoring

  function refresh() {
    const present = checkedValue('attendance') !== 'absent';
    const status = checkedValue('status');
    absentNote.classList.toggle('d-none', present);
    enable($$('[data-lesson-part]').filter((el) => el !== warnings && el !== reason), present);
    const listened = present && (status === 'heard' || status === 'returned');
    enable([warnings], listened);
    form.querySelectorAll('[data-step]').forEach((b) => { b.disabled = !listened; });

    if (!present) {
      reasonBox.classList.add('d-none'); reason.disabled = true;
      setOut('—', '—', '—');
      return;
    }

    const w = Math.max(0, parseInt(warnings.value, 10) || 0);
    const score = Math.max(0, round2(cfg.base - w * rules.pointsPerWarning));
    const overLimit = w >= rules.maxWarnings;
    const belowMin = rules.returnBelowScore > 0 && score < rules.returnBelowScore;
    const returned = status === 'returned' || overLimit || belowMin;
    reasonBox.classList.toggle('d-none', !returned);
    reason.disabled = !returned;
    reason.required = status === 'returned' && !overLimit && !belowMin;
    if (returned) {
      if (status !== 'returned') reason.placeholder = overLimit ? cfg.text.autoReturn : cfg.text.autoLow;
      setOut(status === 'returned' ? '—' : score, lowest, badge('danger', cfg.text.repeat));
      return;
    }
    const level = (rules.levels.find((l) => score >= l.min) || rules.levels[rules.levels.length - 1]).label;
    setOut(score, level, badge('success', cfg.text.passed));
  }

  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-step]');
    if (!b || b.disabled) return;
    warnings.value = Math.max(0, (parseInt(warnings.value, 10) || 0) + Number(b.dataset.step));
    refresh();
  });
  form.addEventListener('change', refresh);
  form.addEventListener('input', (e) => { if (e.target === warnings) refresh(); });
  limitAyah('start'); limitAyah('end');
  refresh(); refreshSize();
}());
