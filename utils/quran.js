'use strict';
/** The 114 surahs of the Quran with their verse (ayah) counts. */
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
].map(([name, verses], i) => ({ number: i + 1, name, verses }));

function getSurah(number) {
  return SURAHS[Number(number) - 1] || null;
}

module.exports = { SURAHS, getSurah };
