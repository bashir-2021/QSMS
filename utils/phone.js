'use strict';
/**
 * Phone numbers as parent logins. People write the same number many ways ("+252 61 555 0100", "0615550100",
 * "615550100"), so numbers are compared by their last 9 digits — a Somali mobile number without the country
 * code or leading 0.
 */
const KEY_DIGITS = 9;
const MIN_DIGITS = 7;

/** The comparable key of a phone number, or null when it has too few digits to be one. */
function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < MIN_DIGITS) return null;
  return digits.slice(-KEY_DIGITS);
}

/** A regex matching stored numbers (with any spaces, dashes or prefix) that end with this key. */
function phoneKeyRegex(key) {
  if (!/^\d+$/.test(String(key || ''))) throw new Error('phoneKeyRegex needs digits');
  return new RegExp(`${key.split('').join('\\D*')}\\D*$`);
}

module.exports = { phoneKey, phoneKeyRegex };
