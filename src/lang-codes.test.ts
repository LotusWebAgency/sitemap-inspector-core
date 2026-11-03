import { describe, expect, it } from 'vitest';
import { _hreflangCacheSize, hreflangProblem, knownLanguage } from './lang-codes.js';

const reason = (v: string) => hreflangProblem(v)?.code ?? null;

describe('hreflangProblem', () => {
  it('accepts x-default and language[-script][-region] codes in any case', () => {
    for (const v of ['x-default', 'X-Default', 'en', 'EN-us', 'en-GB', 'pt-br', 'zh-Hant-TW', 'ZH-hant-tw', 'sr-Latn', 'en-latn-gb']) {
      expect(reason(v), v).toBeNull();
    }
  });

  it('treats codes that are both a language and a country as the language', () => {
    for (const v of ['de', 'es', 'uk', 'uk-ua']) expect(reason(v), v).toBeNull();
  });

  it('flags a country code without a language', () => {
    expect(hreflangProblem('us')).toEqual({
      code: 'hreflang-region-only', params: { value: 'us' },
      message: 'us: a country code without a language; hreflang starts with a language code',
    });
    expect(reason('GB')).toBe('hreflang-region-only');
  });

  it('flags UK used as a region and suggests GB in the same case', () => {
    expect(hreflangProblem('en-uk')).toEqual({
      code: 'hreflang-uk-region', params: { value: 'en-uk', suggestion: 'en-gb' },
      message: 'en-uk: UK is not an ISO 3166-1 code; use en-gb',
    });
    expect(hreflangProblem('en-UK')!.params['suggestion']).toBe('en-GB');
  });

  it('flags numeric UN M.49 regions', () => {
    expect(hreflangProblem('es-419')).toEqual({
      code: 'hreflang-numeric-region', params: { value: 'es-419', region: '419' },
      message: 'es-419: numeric region "419" (UN M.49); use a two-letter country code',
    });
    expect(reason('en-001')).toBe('hreflang-numeric-region');
  });

  it('flags unknown languages, including three-letter ones', () => {
    for (const v of ['zz', 'xx', 'fil', 'eng']) expect(reason(v), v).toBe('hreflang-unknown-language');
    expect(hreflangProblem('zz-latn')).toEqual({
      code: 'hreflang-unknown-language', params: { value: 'zz-latn', language: 'zz' },
      message: 'zz-latn: "zz" is not a two-letter ISO 639-1 language code',
    });
    expect(hreflangProblem('fil')).toEqual({
      code: 'hreflang-unknown-language', params: { value: 'fil', language: 'fil' },
      message: 'fil: "fil" is not a two-letter ISO 639-1 language code',
    });
  });

  it('flags unknown scripts and user-assigned or non-country regions', () => {
    for (const v of ['en-qaaa', 'en-zzzz']) expect(reason(v), v).toBe('hreflang-unknown-script');
    expect(hreflangProblem('en-qaaa')).toEqual({
      code: 'hreflang-unknown-script', params: { value: 'en-qaaa', script: 'qaaa' }, message: 'en-qaaa: "qaaa" is not an ISO 15924 script code',
    });
    for (const v of ['en-zz', 'en-xa', 'en-qo', 'en-aa', 'en-eu', 'en-un', 'en-ez']) expect(reason(v), v).toBe('hreflang-unknown-region');
    expect(hreflangProblem('en-zz')).toEqual({
      code: 'hreflang-unknown-region', params: { value: 'en-zz', region: 'zz' }, message: 'en-zz: "zz" is not an ISO 3166-1 country code',
    });
  });

  it('accepts what ICU still maps: Kosovo, old language codes and withdrawn regions', () => {
    for (const v of ['sq-xk', 'iw', 'in', 'en-cs']) expect(reason(v), v).toBeNull();
  });

  it('flags malformed and oversized values without looking them up', () => {
    for (const v of ['en_US', 'english', 'en-US-x-foo', '', 'e1', 'en-u1']) expect(reason(v), v).toBe('hreflang-malformed');
    expect(hreflangProblem('en_US')).toEqual({ code: 'hreflang-malformed', params: { value: 'en_US' }, message: 'en_US: not a language[-script][-region] code' });
  });

  it('keeps a malformed value of 32 characters whole and cuts a longer one to 32 plus an ellipsis', () => {
    const at32 = 'a'.repeat(32);
    expect(hreflangProblem(at32)).toEqual({ code: 'hreflang-malformed', params: { value: at32 }, message: `${at32}: not a language[-script][-region] code` });
    const cut = `${'a'.repeat(32)}…`;
    expect(hreflangProblem('a'.repeat(33))).toEqual({ code: 'hreflang-malformed', params: { value: cut }, message: `${cut}: not a language[-script][-region] code` });
    expect(hreflangProblem(`en-${'x'.repeat(5000)}`)).toEqual({
      code: 'hreflang-malformed', params: { value: `en-${'x'.repeat(29)}…` }, message: `en-${'x'.repeat(29)}…: not a language[-script][-region] code`,
    });
  });

  it('memoizes a verdict: a new code adds one entry, a repeat lookup adds none', () => {
    const before = _hreflangCacheSize();
    expect(reason('memo-probe-code')).toBe('hreflang-malformed');
    expect(_hreflangCacheSize()).toBe(before + 1);
    expect(reason('memo-probe-code')).toBe('hreflang-malformed');
    expect(_hreflangCacheSize()).toBe(before + 1);
  });

  it('answers 500,000 lookups of repeated codes quickly and correctly', () => {
    const t0 = performance.now();
    let flagged = 0;
    for (let i = 0; i < 500_000; i++) if (hreflangProblem(i % 2 ? 'en-gb' : 'de-at')) flagged++;
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(flagged).toBe(0);
    expect(reason('en-uk')).toBe('hreflang-uk-region');
  });

  it('keeps at most 1,000 verdicts and stays correct past the cap', () => {
    for (let i = 0; i < 1800; i++) expect(reason(`${i < 900 ? 'en' : 'de'}-${100 + (i % 900)}`)).toBe('hreflang-numeric-region');
    expect(_hreflangCacheSize()).toBeLessThanOrEqual(1000);
    expect(reason('fr-ca')).toBeNull();
    expect(reason('fr-uk')).toBe('hreflang-uk-region');
  });

  it('clears the memo when full instead of refusing new verdicts', () => {
    for (let i = 0; _hreflangCacheSize() < 1000; i++) hreflangProblem(`pin${i}`);
    expect(_hreflangCacheSize()).toBe(1000);
    hreflangProblem('pin0'); // already memoized: a hit at the cap does not clear anything
    expect(_hreflangCacheSize()).toBe(1000);
    hreflangProblem('one-more-code');
    expect(_hreflangCacheSize()).toBe(1);
    expect(reason('pin0')).toBe('hreflang-malformed'); // a dropped verdict is computed again, not lost
    expect(_hreflangCacheSize()).toBe(2);
  });
});

describe('knownLanguage', () => {
  it('knows bare two- and three-letter language subtags in any case', () => {
    for (const v of ['en', 'EN', 'eng', 'fil']) expect(knownLanguage(v), v).toBe(true);
    for (const v of ['zz', 'und', 'en-us', 'e', 'english']) expect(knownLanguage(v), v).toBe(false);
  });
});
