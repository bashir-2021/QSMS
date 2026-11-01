'use strict';
const money = require('../utils/money');
const seq = require('../services/sequenceService');

describe('money (integer minor units)', () => {
  test('parses decimal strings without floating point error', () => {
    expect(money.toMinor('0.1')).toBe(10);
    expect(money.toMinor('0.2')).toBe(20);
    expect(money.toMinor('0.1') + money.toMinor('0.2')).toBe(30); // 0.1 + 0.2 === 0.3 in cents
    expect(money.toMinor('1,250.5')).toBe(125050);
    expect(money.toMinor('19.99')).toBe(1999);
    expect(money.toMinor('7')).toBe(700);
  });

  test('rejects invalid input', () => {
    ['', 'abc', '1.234', '1e5', null, undefined, '--1'].forEach((v) => expect(money.toMinor(v)).toBeNull());
  });

  test('formats amounts', () => {
    expect(money.format(125050, 'USD')).toBe('$1,250.50');
    expect(money.format(-500, 'USD')).toBe('-$5.00');
    expect(money.toDecimalString(5)).toBe('0.05');
  });

  test('arithmetic refuses non-integers', () => {
    expect(() => money.add(10, 0.5)).toThrow();
    expect(money.sum([{ a: 10 }, { a: 20 }], 'a')).toBe(30);
  });
});

describe('document numbering', () => {
  test('renders configurable formats', () => {
    const d = new Date(Date.UTC(2026, 10, 1));
    expect(seq.render('RCT-{YYYY}-{SEQ:5}', 42, d)).toBe('RCT-2026-00042');
    expect(seq.render('INV{YY}{MM}-{SEQ:3}', 7, d)).toBe('INV2611-007');
  });
});
