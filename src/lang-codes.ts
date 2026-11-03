import type { HreflangExampleCode, Params } from './types.js';

// Code existence comes from the browser's ICU data: Intl.DisplayNames with fallback 'none' answers undefined for
// an unknown code, so no ISO tables ship with the extension. Lookups need canonical case per subtag (region "us"
// is unknown, "US" is not) and bare subtags only (type 'language' would also name a whole tag like "en-US").
// Where ICU and ISO disagree, the rulings are pinned in core/lang-codes.test.ts.
interface Names { language: Intl.DisplayNames; script: Intl.DisplayNames; region: Intl.DisplayNames }
let names: Names | null | undefined;

function displayNames(): Names | null {
  if (names === undefined) {
    try {
      const make = (type: 'language' | 'script' | 'region') => new Intl.DisplayNames(['en'], { type, fallback: 'none' });
      names = { language: make('language'), script: make('script'), region: make('region') };
    } catch {
      names = null; // no ICU data: only the format checks apply
    }
  }
  return names;
}

function known(type: keyof Names, code: string): boolean {
  const n = displayNames();
  if (!n) return true;
  try { return n[type].of(code) !== undefined; } catch { return false; } // of() throws RangeError on a malformed subtag
}

const LANGUAGE = /^[a-z]{2,3}$/i;

/** A bare ISO 639 language subtag (2 or 3 letters, any case) that ICU knows. */
export function knownLanguage(code: string): boolean {
  return LANGUAGE.test(code) && known('language', code.toLowerCase());
}

// ISO 3166-1 user-assigned codes (AA, QM–QZ, XA–XZ, ZZ) and the reserved EU / EZ / UN are not countries, though ICU
// names several of them. XK (Kosovo) is user-assigned but in wide use, so it is accepted.
const USER_ASSIGNED = /^(?:AA|Q[M-Z]|X[A-Z]|ZZ)$/;
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN']);
const isCountry = (upper: string): boolean =>
  upper === 'XK' || (!USER_ASSIGNED.test(upper) && !NOT_COUNTRIES.has(upper) && known('region', upper));

function isScript(script: string): boolean {
  const title = script.charAt(0).toUpperCase() + script.slice(1).toLowerCase();
  return title !== 'Zzzz' && known('script', title); // Zzzz is ISO 15924's "uncoded script", meaningless in hreflang
}

export interface CodeProblem { code: HreflangExampleCode; params: Params; message: string }

const HREFLANG = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;
const NUMERIC = /^\d{3}$/;
const MAX_CODE_CHARS = 32; // the longest valid code has 11 chars; longer values are malformed without a lookup
const MAX_CACHED = 1000;
const cache = new Map<string, CodeProblem | null>();

export function _hreflangCacheSize(): number {
  return cache.size;
}

function malformed(value: string): CodeProblem {
  return { code: 'hreflang-malformed', params: { value }, message: `${value}: not a language[-script][-region] code` };
}

function check(value: string): CodeProblem | null {
  if (value.toLowerCase() === 'x-default') return null;
  const m = HREFLANG.exec(value);
  if (!m) return malformed(value);
  const [, language = '', script, region] = m;
  if (language.length !== 2 || !knownLanguage(language)) {
    if (language.length === 2 && script === undefined && region === undefined && isCountry(language.toUpperCase())) {
      return { code: 'hreflang-region-only', params: { value }, message: `${value}: a country code without a language; hreflang starts with a language code` };
    }
    return { code: 'hreflang-unknown-language', params: { value, language }, message: `${value}: "${language}" is not a two-letter ISO 639-1 language code` };
  }
  if (script !== undefined && !isScript(script)) {
    return { code: 'hreflang-unknown-script', params: { value, script }, message: `${value}: "${script}" is not an ISO 15924 script code` };
  }
  if (region === undefined) return null;
  if (NUMERIC.test(region)) {
    return { code: 'hreflang-numeric-region', params: { value, region }, message: `${value}: numeric region "${region}" (UN M.49); use a two-letter country code` };
  }
  if (region.toUpperCase() === 'UK') {
    const suggestion = value.slice(0, -2) + (region === 'UK' ? 'GB' : 'gb');
    return { code: 'hreflang-uk-region', params: { value, suggestion }, message: `${value}: UK is not an ISO 3166-1 code; use ${suggestion}` };
  }
  if (!isCountry(region.toUpperCase())) {
    return { code: 'hreflang-unknown-region', params: { value, region }, message: `${value}: "${region}" is not an ISO 3166-1 country code` };
  }
  return null;
}

/**
 * Google's hreflang rule: x-default, or an ISO 639-1 language, an optional ISO 15924 script and an optional
 * ISO 3166-1 alpha-2 region, in any case. null when the value is valid; otherwise the reason, with the English
 * example text in `message`.
 */
export function hreflangProblem(value: string): CodeProblem | null {
  if (value.length > MAX_CODE_CHARS) return malformed(`${value.slice(0, MAX_CODE_CHARS)}…`);
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const result = check(value);
  if (cache.size >= MAX_CACHED) cache.clear(); // a flood of junk codes must not lock the real ones out of the memo
  cache.set(value, result);
  return result;
}
