/**
 * The linear-time matcher has to give exactly the answer `RegExp` gives, on every
 * pattern it accepts — a rule must not mean one thing in a regex tester and another
 * in the import. So most of this file is a differential test against V8, on
 * patterns and inputs chosen to be cheap for V8 to answer.
 */

import { describe, expect, it } from 'vitest';

import { LinearRegexError, compileLinearRegex } from './linear-regex';

const PATTERNS: readonly string[] = [
  '^SQ[0-9]{6}$',
  'PO SOOZ-\\d{4}-\\d{3}',
  '(FEDEX|UPS)',
  'Corporate Card - \\d{4} \\(Business( Virtual)? Card\\)',
  '^Relay$',
  'abc',
  'a|b|c',
  'a*b+c?',
  'colou?r',
  '^\\s*$',
  '\\bAMAZON\\b',
  '\\Bmazon',
  '[A-Z]{2,4}\\d+',
  '[^a-z]+',
  '[a\\-z]',
  '[\\d.]+',
  '[\\w-]+@',
  '.+',
  '^.{3}$',
  'x{0}y',
  'a{2,}',
  'a{1,3}b',
  '(?:ab)+c',
  '(?<word>foo)bar',
  '(a|ab)(c|bcd)(d*)',
  '^(?:(\\d{1,3}),)*\\d{3}$',
  '\\$\\d+\\.\\d{2}',
  'a{2,',
  '}]',
  '\\x41\\u0042',
  '\\t',
  '[\\b]',
  'a*?b',
  '(a+?)c',
  '^$',
  '',
  '\\cJ',
  '\\.',
  '\\/',
];

const INPUTS: readonly string[] = [
  '',
  'SQ260126',
  'SQ26012',
  'xSQ260126',
  'PO SOOZ-2026-001 / CO10191 - Sent By Boxuan Zhao',
  'Corporate Card - 1892 (Business Card)',
  'Corporate Card - 8796 (Business Virtual Card)',
  'Relay',
  'FEDEX533300619',
  'ups store',
  'abc',
  'aabbbc',
  'color colour',
  '   ',
  'AMAZON MKTPL',
  'AMAZONIA',
  'Amazon',
  'ABC123',
  'hello world',
  'a-z',
  '1.2.3',
  'john-doe@',
  'xyz',
  'y',
  'aaa',
  'aab',
  'ababc',
  'abcd',
  '1,234,567',
  '234',
  '$12.34',
  'a{2,',
  '}]',
  'AB',
  '\t',
  '\b',
  'aaab',
  'aac',
  '\n',
  '.',
  '/',
  'foobar',
];

describe('compileLinearRegex agrees with RegExp', () => {
  for (const pattern of PATTERNS) {
    it(`/${pattern}/`, () => {
      const linear = compileLinearRegex(pattern);
      const native = new RegExp(pattern);
      for (const input of INPUTS) {
        expect(linear.test(input), `${JSON.stringify(input)}`).toBe(native.test(input));
      }
    });
  }
});

describe('compileLinearRegex refuses what needs backtracking', () => {
  it.each([
    ['(a)\\1', /back-reference/],
    ['(?<x>a)\\k<x>', /back-reference/],
    ['a(?=b)', /lookahead/],
    ['a(?!b)', /lookahead/],
    ['(?<=a)b', /lookbehind/],
    ['(?<!a)b', /lookbehind/],
    ['(', /does not compile|unbalanced/],
    ['[a', /does not compile|unterminated/],
    ['*a', /does not compile|nothing to repeat/],
    ['a{1001}', /above 1000/],
    ['(a{100}){100}', /more than 5000 states/],
  ])('%s', (pattern, reason) => {
    expect(() => compileLinearRegex(pattern)).toThrow(LinearRegexError);
    expect(() => compileLinearRegex(pattern)).toThrow(reason);
  });
});

describe('compileLinearRegex is linear', () => {
  it('matches patterns that backtrack catastrophically in V8, at input lengths V8 cannot finish', () => {
    const cases: Array<[string, string]> = [
      ['\\d*\\d*\\d*\\d*\\d*\\d*\\d*x', '7'.repeat(20_000)],
      ['.*.*.*.*.*.*!', 'a'.repeat(20_000)],
      ['^(a+)+$', `${'a'.repeat(20_000)}!`],
      ['^(a|aa)*$', `${'a'.repeat(20_000)}b`],
      ['(x+x+)+y', 'x'.repeat(20_000)],
    ];
    for (const [pattern, input] of cases) {
      const regex = compileLinearRegex(pattern);
      const started = performance.now();
      expect(regex.test(input), pattern).toBe(false);
      const elapsed = performance.now() - started;
      // 20,000 characters is forty times the rule engine's input cap.
      expect(elapsed, `${pattern}: ${elapsed.toFixed(1)}ms`).toBeLessThan(2000);
    }
  });
});
