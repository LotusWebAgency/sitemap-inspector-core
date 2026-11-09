import { describe, expect, it } from 'vitest';
import { isFullW3CDate, isValidW3CDate, parseW3CDate } from './w3c-date.js';

describe('parseW3CDate', () => {
  it('gives the time of a valid W3C date and NaN for anything else, the same on a repeat', () => {
    for (const d of ['2026', '2026-05', '2026-05-01', '2026-05-01T10:30Z', '2026-05-01T10:30:00.5+02:00']) {
      expect(parseW3CDate(d), d).toBe(Date.parse(d));
      expect(parseW3CDate(d), `${d} again`).toBe(Date.parse(d));
    }
    for (const d of ['2026-02-30', '01.05.2026', 'Wed, 01 Jul 2026 00:00:00 GMT', '']) {
      expect(parseW3CDate(d), d).toBeNaN();
      expect(parseW3CDate(d), `${d} again`).toBeNaN();
    }
  });
});

describe('isValidW3CDate', () => {
  it('accepts valid forms', () => {
    for (const d of ['2026-05-01', '2026-05-01T10:30Z', '2026-05-01T10:30:00Z', '2026-05-01T10:30:00.5+02:00']) expect(isValidW3CDate(d), d).toBe(true);
  });
  it('rejects invalid forms', () => {
    for (const d of ['01.05.2026', '2026-13-45', '2026-05-01 10:30', '2026-05-01T10:30', 'yesterday', '']) expect(isValidW3CDate(d), d).toBe(false);
  });
});

describe('isValidW3CDate (W3C Datetime profile)', () => {
  it('accepts the year and year-month forms and leap days', () => {
    for (const d of ['2026', '2026-05', '2026-12', '2024-02-29', '2000-02-29', '2026-01-31', '2026-06-30', '2026-05-01T23:59:59.123456Z', '2026-05-01T23:59Z', '2026-05-01T00:00-14:00', '2026-05-01T10:30+23:59']) expect(isValidW3CDate(d), d).toBe(true);
  });
  it('rejects calendar and clock overflow that Date.parse tolerates', () => {
    for (const d of ['2024-02-31', '2023-02-29', '1900-02-29', '2026-04-31', '2026-06-31', '2026-13', '2026-00-10', '2026-05-00', '2026-00',
      '2026-05-01T24:00:00Z', '2026-05-01T10:60Z', '2026-05-01T10:30:60Z', '2026-05-01T10:30+24:00', '2026-05-01T10:30+02:60',
      '2026-5-1', '20260501', '2026-05-01T10Z', '2026-05-01T10:30:00']) expect(isValidW3CDate(d), d).toBe(false);
  });
  it('is linear on a long fractional part', () => {
    const t0 = performance.now();
    expect(isValidW3CDate('2026-05-01T10:30:00.' + '1'.repeat(200_000) + 'x')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('isFullW3CDate', () => {
  it('needs at least a full calendar date', () => {
    for (const d of ['2026-05-01', '2026-05-01T10:30Z', '2026-05-01T10:30:00.5+02:00']) expect(isFullW3CDate(d), d).toBe(true);
    for (const d of ['2026', '2026-05', '2026-02-30', '2026-05-01T24:00Z', '26 Aug 2026', '']) expect(isFullW3CDate(d), d).toBe(false);
  });
});
