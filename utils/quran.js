'use strict';
const { PAGE_STARTS, JUZ_STARTS, ARABIC_NAMES } = require('./mushafData');

/** The 114 surahs of the Quran with their Arabic names and verse (ayah) counts. */
const SURAHS = [
  ['Al-Fatihah', 7], ['Al-Baqarah', 286], ['Aal-Imran', 200], ['An-Nisa', 176], ['Al-Maidah', 120],
  ["Al-An'am", 165], ["Al-A'raf", 206], ['Al-Anfal', 75], ['At-Tawbah', 129], ['Yunus', 109],
  ['Hud', 123], ['Yusuf', 111], ["Ar-Ra'd", 43], ['Ibrahim', 52], ['Al-Hijr', 99],
  ['An-Nahl', 128], ['Al-Isra', 111], ['Al-Kahf', 110], ['Maryam', 98], ['Ta-Ha', 135],
  ['Al-Anbiya', 112], ['Al-Hajj', 78], ["Al-Mu'minun", 118], ['An-Nur', 64], ['Al-Furqan', 77],
  ["Ash-Shu'ara", 227], ['An-Naml', 93], ['Al-Qasas', 88], ['Al-Ankabut', 69], ['Ar-Rum', 60],
  ['Luqman', 34], ['As-Sajdah', 30], ['Al-Ahzab', 73], ['Saba', 54], ['Fatir', 45],
  ['Ya-Sin', 83], ['As-Saffat', 182], ['Sad', 88], ['Az-Zumar', 75], ['Ghafir', 85],
  ['Fussilat', 54], ['Ash-Shura', 53], ['Az-Zukhruf', 89], ['Ad-Dukhan', 59], ['Al-Jathiyah', 37],
  ['Al-Ahqaf', 35], ['Muhammad', 38], ['Al-Fath', 29], ['Al-Hujurat', 18], ['Qaf', 45],
  ['Adh-Dhariyat', 60], ['At-Tur', 49], ['An-Najm', 62], ['Al-Qamar', 55], ['Ar-Rahman', 78],
  ["Al-Waqi'ah", 96], ['Al-Hadid', 29], ['Al-Mujadilah', 22], ['Al-Hashr', 24], ['Al-Mumtahanah', 13],
  ['As-Saff', 14], ["Al-Jumu'ah", 11], ['Al-Munafiqun', 11], ['At-Taghabun', 18], ['At-Talaq', 12],
  ['At-Tahrim', 12], ['Al-Mulk', 30], ['Al-Qalam', 52], ['Al-Haqqah', 52], ["Al-Ma'arij", 44],
  ['Nuh', 28], ['Al-Jinn', 28], ['Al-Muzzammil', 20], ['Al-Muddaththir', 56], ['Al-Qiyamah', 40],
  ['Al-Insan', 31], ['Al-Mursalat', 50], ['An-Naba', 40], ["An-Nazi'at", 46], ['Abasa', 42],
  ['At-Takwir', 29], ['Al-Infitar', 19], ['Al-Mutaffifin', 36], ['Al-Inshiqaq', 25], ['Al-Buruj', 22],
  ['At-Tariq', 17], ["Al-A'la", 19], ['Al-Ghashiyah', 26], ['Al-Fajr', 30], ['Al-Balad', 20],
  ['Ash-Shams', 15], ['Al-Layl', 21], ['Ad-Duha', 11], ['Ash-Sharh', 8], ['At-Tin', 8],
  ['Al-Alaq', 19], ['Al-Qadr', 5], ['Al-Bayyinah', 8], ['Az-Zalzalah', 8], ["Al-'Adiyat", 11],
  ["Al-Qari'ah", 11], ['At-Takathur', 8], ["Al-'Asr", 3], ['Al-Humazah', 9], ['Al-Fil', 5],
  ['Quraysh', 4], ["Al-Ma'un", 7], ['Al-Kawthar', 3], ['Al-Kafirun', 6], ['An-Nasr', 3],
  ['Al-Masad', 5], ['Al-Ikhlas', 4], ['Al-Falaq', 5], ['An-Nas', 6],
].map(([name, verses], i) => ({ number: i + 1, name, arabic: ARABIC_NAMES[i], verses }));

function getSurah(number) {
  return SURAHS[Number(number) - 1] || null;
}

/* ------------------------- Madinah Mushaf (604 pages) ----------------------- */
// Ayahs are numbered 1..6236 across the whole Quran so ranges can span surahs.
const SURAH_STARTS = [];
SURAHS.reduce((next, s) => { SURAH_STARTS.push(next); return next + s.verses; }, 1);
const TOTAL_AYAHS = 6236;
const TOTAL_PAGES = PAGE_STARTS.length;

/** Global number of an ayah, or null when the surah or ayah does not exist. */
function ayahId(surah, ayah) {
  const s = getSurah(surah);
  const a = Number(ayah);
  if (!s || !Number.isInteger(a) || a < 1 || a > s.verses) return null;
  return SURAH_STARTS[s.number - 1] + a - 1;
}

/** Last index i with list[i] <= id (list sorted ascending). */
function lastAtOrBefore(list, id) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (list[mid] <= id) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const fromAyahId = (id) => {
  const i = lastAtOrBefore(SURAH_STARTS, id);
  return { surah: i + 1, ayah: id - SURAH_STARTS[i] + 1 };
};
const pageOf = (id) => lastAtOrBefore(PAGE_STARTS, id) + 1;
const juzOf = (id) => lastAtOrBefore(JUZ_STARTS, id) + 1;
const juzFirst = (j) => JUZ_STARTS[j - 1];
const juzLast = (j) => (j < 30 ? JUZ_STARTS[j] - 1 : TOTAL_AYAHS);

/** First and last ayah of a juz, to fill a lesson that covers a whole juz. */
function juzRange(juz) {
  const j = Number(juz);
  if (!(Number.isInteger(j) && j >= 1 && j <= 30)) return null;
  return { start: fromAyahId(juzFirst(j)), end: fromAyahId(juzLast(j)) };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Each ayah weighs its share of its Mushaf page (1 / ayahs on that page), so a juz is measured by
// page area rather than by ayah count. PAGE_WEIGHT[id] is the summed weight of ayahs 1..id.
const PAGE_WEIGHT = new Float64Array(TOTAL_AYAHS + 1);
for (let id = 1; id <= TOTAL_AYAHS; id += 1) {
  const p = pageOf(id);
  const onPage = (p < TOTAL_PAGES ? PAGE_STARTS[p] : TOTAL_AYAHS + 1) - PAGE_STARTS[p - 1];
  PAGE_WEIGHT[id] = PAGE_WEIGHT[id - 1] + 1 / onPage;
}
const weight = (from, to) => PAGE_WEIGHT[to] - PAGE_WEIGHT[from - 1];

/**
 * How much of the Quran a lesson covers, from its first ayah to its last (inclusive):
 * ayahs, the Mushaf pages it spans, and how many juz that is (each juz's share by page area, summed).
 */
function measure(start, end) {
  const from = ayahId(start && start.surah, start && start.ayah);
  const to = ayahId(end && end.surah, end && end.ayah);
  if (!from || !to || to < from) return null;
  const startJuz = juzOf(from);
  const endJuz = juzOf(to);
  let juz = 0;
  for (let j = startJuz; j <= endJuz; j += 1) {
    juz += weight(Math.max(from, juzFirst(j)), Math.min(to, juzLast(j))) / weight(juzFirst(j), juzLast(j));
  }
  const startPage = pageOf(from);
  const endPage = pageOf(to);
  return {
    ayahs: to - from + 1, startPage, endPage, pages: endPage - startPage + 1, startJuz, endJuz, juz: round2(juz),
  };
}

/** "Al-Baqarah 1–5" or "Al-Baqarah 280 – Aal-Imran 10"; `arabic` uses the Arabic surah names. */
function portionText(l, { arabic = false } = {}) {
  if (!l || !l.start || !l.start.surah) return l && l.topic ? l.topic : '';
  const name = (n) => { const s = getSurah(n); return s ? (arabic ? s.arabic : s.name) : ''; };
  const text = l.start.surah === l.end.surah
    ? `${name(l.start.surah)} ${l.start.ayah}–${l.end.ayah}`
    : `${name(l.start.surah)} ${l.start.ayah} – ${name(l.end.surah)} ${l.end.ayah}`;
  return l.topic ? `${text} · ${l.topic}` : text;
}

/** A lesson's return reason in the reader's language: automatic reasons are stored in English with their numbers. */
function reasonText(t, row) {
  const text = (row && (row.returnReason || row.reason)) || '';
  let m = /^Reached the warning limit \((\d+)\/(\d+)\)$/.exec(text);
  if (m) return t('Reached the warning limit ({n}/{max})', { n: m[1], max: m[2] });
  m = /^Score below (\d+)$/.exec(text);
  if (m) return t('Score below {min}', { min: m[1] });
  return text;
}

module.exports = {
  SURAHS, getSurah, TOTAL_AYAHS, TOTAL_PAGES, ayahId, fromAyahId, pageOf, juzOf, juzRange, measure, portionText, reasonText,
  // the raw layout, for the lesson form's live preview
  layout: () => ({ surahStarts: SURAH_STARTS, pageStarts: PAGE_STARTS, juzStarts: JUZ_STARTS, verses: SURAHS.map((s) => s.verses) }),
};
