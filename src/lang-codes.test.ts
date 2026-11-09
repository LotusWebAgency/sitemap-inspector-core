import { afterEach, describe, expect, it, vi } from 'vitest';
import { hreflangProblem, knownLanguage } from './lang-codes.js';

const reason = (v: string) => hreflangProblem(v)?.code ?? null;

// A private instance of the module: its memo and display-name tables start empty, whatever ran before.
async function freshModule(): Promise<typeof import('./lang-codes.js')> {
  vi.resetModules();
  return import('./lang-codes.js');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('hreflangProblem', () => {
  it('accepts x-default and language[-script][-region] codes in any case', () => {
    for (const v of ['x-default', 'X-Default', 'en', 'EN-us', 'en-GB', 'pt-br', 'zh-Hant-TW', 'ZH-hant-tw', 'sr-Latn', 'en-latn-gb']) {
      expect(reason(v), v).toBeNull();
    }
  });

  it('treats codes that are both a language and a country as the language', () => {
    for (const v of ['de', 'es', 'uk', 'uk-ua']) expect(reason(v), v).toBeNull();
  });

  it('flags a two-letter country code with a script or a region as an unknown language, not as a bare country code', () => {
    expect(hreflangProblem('us-latn')).toEqual({
      code: 'hreflang-unknown-language', params: { value: 'us-latn', language: 'us' },
      message: 'us-latn: "us" is not a two-letter ISO 639-1 language code',
    });
    expect(hreflangProblem('us-gb')).toEqual({
      code: 'hreflang-unknown-language', params: { value: 'us-gb', language: 'us' },
      message: 'us-gb: "us" is not a two-letter ISO 639-1 language code',
    });
    expect(reason('gb-latn-us')).toBe('hreflang-unknown-language');
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

  it('memoizes a verdict: a new code adds one entry, a repeat lookup adds none', async () => {
    const m = await freshModule();
    expect(m._hreflangCacheSize()).toBe(0);
    expect(m.hreflangProblem('memo-probe-code')?.code).toBe('hreflang-malformed');
    expect(m._hreflangCacheSize()).toBe(1);
    expect(m.hreflangProblem('memo-probe-code')?.code).toBe('hreflang-malformed');
    expect(m._hreflangCacheSize()).toBe(1);
  });

  it('asks ICU nothing for 500,000 lookups of codes it has already judged', async () => {
    const m = await freshModule();
    const of = vi.spyOn(Intl.DisplayNames.prototype, 'of');
    expect(m.hreflangProblem('en-gb')).toBeNull();
    expect(m.hreflangProblem('de-at')).toBeNull();
    expect(of).toHaveBeenCalledTimes(4);
    let flagged = 0;
    for (let i = 0; i < 500_000; i++) if (m.hreflangProblem(i % 2 ? 'en-gb' : 'de-at')) flagged++;
    expect(flagged).toBe(0);
    expect(of).toHaveBeenCalledTimes(4);
    expect(m.hreflangProblem('en-uk')?.code).toBe('hreflang-uk-region');
  });

  it('keeps at most 1,000 verdicts and stays correct past the cap', async () => {
    const m = await freshModule();
    for (let i = 0; i < 1800; i++) expect(m.hreflangProblem(`${i < 900 ? 'en' : 'de'}-${100 + (i % 900)}`)?.code).toBe('hreflang-numeric-region');
    expect(m._hreflangCacheSize()).toBeLessThanOrEqual(1000);
    expect(m.hreflangProblem('fr-ca')).toBeNull();
    expect(m.hreflangProblem('fr-uk')?.code).toBe('hreflang-uk-region');
  });

  it('clears the memo when full instead of refusing new verdicts', async () => {
    const m = await freshModule();
    for (let i = 0; i < 1000; i++) m.hreflangProblem(`pin${i}`);
    expect(m._hreflangCacheSize()).toBe(1000);
    m.hreflangProblem('pin0'); // already memoized: a hit at the cap does not clear anything
    expect(m._hreflangCacheSize()).toBe(1000);
    m.hreflangProblem('one-more-code');
    expect(m._hreflangCacheSize()).toBe(1);
    expect(m.hreflangProblem('pin0')?.code).toBe('hreflang-malformed'); // a dropped verdict is computed again, not lost
    expect(m._hreflangCacheSize()).toBe(2);
  });
});

describe('ICU display-name tables', () => {
  it('builds the English language, script and region tables once, on first use', async () => {
    const m = await freshModule();
    const ctor = vi.spyOn(Intl, 'DisplayNames');
    expect(ctor).not.toHaveBeenCalled();
    expect(m.hreflangProblem('en-latn-gb')).toBeNull();
    expect(m.hreflangProblem('de-at')).toBeNull();
    expect(m.hreflangProblem('us')?.code).toBe('hreflang-region-only');
    expect(m.knownLanguage('fr')).toBe(true);
    expect(ctor.mock.calls).toEqual([
      [['en'], { type: 'language', fallback: 'none' }],
      [['en'], { type: 'script', fallback: 'none' }],
      [['en'], { type: 'region', fallback: 'none' }],
    ]);
  });

  it('applies only the format checks when the runtime has no ICU data, and asks for the tables once', async () => {
    const m = await freshModule();
    const ctor = vi.spyOn(Intl, 'DisplayNames').mockImplementation(() => { throw new RangeError('no ICU data'); });
    for (const v of ['zz', 'en-qaaa', 'us', 'en-gb', 'iw-xk']) expect(m.hreflangProblem(v), v).toBeNull();
    expect(m.hreflangProblem('en-uk')?.code).toBe('hreflang-uk-region');
    expect(m.hreflangProblem('en-zz')?.code).toBe('hreflang-unknown-region');
    expect(m.hreflangProblem('eng')).toEqual({
      code: 'hreflang-unknown-language', params: { value: 'eng', language: 'eng' },
      message: 'eng: "eng" is not a two-letter ISO 639-1 language code',
    });
    expect(m.hreflangProblem('en_US')?.code).toBe('hreflang-malformed');
    expect(m.knownLanguage('zz')).toBe(true);
    expect(m.knownLanguage('z')).toBe(false);
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});

describe('knownLanguage', () => {
  it('knows bare two- and three-letter language subtags in any case', () => {
    for (const v of ['en', 'EN', 'eng', 'fil']) expect(knownLanguage(v), v).toBe(true);
    for (const v of ['zz', 'und', 'en-us', 'e', 'english']) expect(knownLanguage(v), v).toBe(false);
  });
});
