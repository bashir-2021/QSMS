'use strict';
/**
 * Lightweight i18n. English text is the translation key, so untranslated strings fall back to English.
 * Dictionaries: locales/<lang>/*.json (flat { "English text": "Translation" }), merged per language.
 * Placeholders use {name}: t('{name} registered as {code}.', { name, code }).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_LANG = 'en';
const LANGS = {
  en: { code: 'en', name: 'English', dir: 'ltr' },
  ar: { code: 'ar', name: 'العربية', dir: 'rtl' },
  so: { code: 'so', name: 'Soomaali', dir: 'ltr' },
};
const COOKIE = 'quranic.lang';
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

const dictionaries = {};
function load() {
  Object.keys(LANGS).forEach((lang) => {
    const dict = {};
    const dir = path.join(LOCALES_DIR, lang);
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().forEach((f) => {
        try {
          Object.assign(dict, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')));
        } catch (err) {
          console.error(`[i18n] could not load ${lang}/${f}: ${err.message}`);
        }
      });
    }
    dictionaries[lang] = dict;
  });
}
load();

const normalize = (lang) => (LANGS[lang] ? lang : DEFAULT_LANG);

function translate(lang, key, vars) {
  if (key === undefined || key === null) return '';
  const text = String(key);
  const dict = dictionaries[normalize(lang)] || {};
  let out = Object.prototype.hasOwnProperty.call(dict, text) && dict[text] ? dict[text] : text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
  return out;
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE.replace('.', '\\.')}=([a-z]{2})`));
  return m ? m[1] : null;
}

function setLangCookie(res, lang, secure) {
  res.cookie(COOKIE, normalize(lang), { maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: Boolean(secure) });
}

/** Resolve the request language (cookie, else English) and expose t() to controllers and views. */
function middleware(req, res, next) {
  const lang = normalize(readCookie(req));
  req.lang = lang;
  req.t = (key, vars) => translate(lang, key, vars);
  res.locals.lang = lang;
  res.locals.dir = LANGS[lang].dir;
  res.locals.LANGS = LANGS;
  res.locals.t = req.t;
  next();
}

module.exports = { DEFAULT_LANG, LANGS, COOKIE, translate, middleware, setLangCookie, normalize, load };
