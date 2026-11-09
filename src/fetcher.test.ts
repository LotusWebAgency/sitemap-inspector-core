import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyHead, fetchTextStream, mediaType, NotUtf8Error, sniffSitemap, type Transport } from './fetcher.js';

function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } });
}
const enc = (s: string) => new TextEncoder().encode(s);
function mockFetch(body: ReadableStream<Uint8Array> | null, init: { status?: number; url?: string; redirected?: boolean; headers?: Record<string, string> } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const res = new Response(body, { status: init.status ?? 200, ...(init.headers ? { headers: init.headers } : {}) });
    Object.defineProperty(res, 'url', { value: init.url ?? 'https://a.com/sitemap.xml' });
    Object.defineProperty(res, 'redirected', { value: init.redirected ?? false });
    return res;
  }));
}
async function drain(stream: ReadableStream<string>): Promise<string> {
  let out = ''; const r = stream.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) return out; out += value; }
}
afterEach(() => vi.unstubAllGlobals());

describe('classifyHead', () => {
  it('classifies urlset/sitemapindex through prolog, BOM and comments', () => {
    expect(classifyHead('﻿<?xml version="1.0"?>\n<!-- c -->\n<urlset xmlns="x">')).toBe('urlset');
    expect(classifyHead('<sitemapindex>')).toBe('sitemapindex');
    expect(classifyHead('<!DOCTYPE html><html>')).toBe('not-sitemap');
    expect(classifyHead('plain text')).toBe('not-sitemap');
  });
  it('reads past a DOCTYPE with an internal subset, quotes and comments in it included', () => {
    expect(classifyHead('<!DOCTYPE urlset [<!ENTITY a "b">]><urlset xmlns="x">')).toBe('urlset');
    expect(classifyHead('<?xml version="1.0"?>\n<!DOCTYPE sitemapindex [\n<!ENTITY a "x>y">\n<!-- it\'s > fine -->\n<?pi \' >?>\n]>\n<sitemapindex>')).toBe('sitemapindex');
    expect(classifyHead('<!DOCTYPE urlset PUBLIC "-//x>y" "http://a.com/x.dtd"><urlset>')).toBe('urlset');
    expect(classifyHead('<!DOCTYPE urlset [<?>]><urlset>')).toBe('urlset'); // an empty processing instruction closes at once
    expect(classifyHead('<!DOCTYPE urlset [<!ENTITY a "b">')).toBe('not-sitemap'); // the head ends inside the subset
  });
  it('reads the root name through a namespace prefix, in any case', () => {
    expect(classifyHead('<s:urlset xmlns:s="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe('urlset');
    expect(classifyHead('<ns:sitemapindex xmlns:ns="x">')).toBe('sitemapindex');
    expect(classifyHead('<a:b:urlset>')).toBe('urlset');
    expect(classifyHead('<S:URLSET>')).toBe('urlset');
    expect(classifyHead('<s:html xmlns:s="x">')).toBe('not-sitemap');
    expect(classifyHead('<> urlset')).toBe('not-sitemap');
  });
  it('skips a comment that holds a > and a declaration before the root', () => {
    expect(classifyHead('<!-- a > b --><urlset>')).toBe('urlset');
    expect(classifyHead('<?xml version="1.0"?>\n<!-- a > b -->\n<!FOO bar>\n<urlset>')).toBe('urlset');
    expect(classifyHead('<!FOO bar><sitemapindex>')).toBe('sitemapindex');
  });
  it('reads past a DOCTYPE whose quotes, comments and processing instructions hide a ] or a >', () => {
    expect(classifyHead('<!DOCTYPE urlset PUBLIC \'-//x>y\' \'http://a.com/x.dtd\'><urlset>')).toBe('urlset');
    expect(classifyHead('<!DOCTYPE urlset [<!ENTITY a \'x]y\'>]><urlset>')).toBe('urlset');
    expect(classifyHead('<!DOCTYPE urlset [<!ENTITY a "x]y">]><urlset>')).toBe('urlset');
    expect(classifyHead('<!DOCTYPE urlset [<!-- ] > --><!ENTITY a "b">]><urlset>')).toBe('urlset');
    expect(classifyHead('<!DOCTYPE urlset [<?pi ] > ?><!ENTITY a "b">]><urlset>')).toBe('urlset');
    expect(classifyHead('<!DOCTYPE urlset [<!-->]><urlset>')).toBe('urlset'); // <!--> closes at once, like the tokenizer
  });
  it('ends on a DOCTYPE, comment, processing instruction or declaration the head never closes', () => {
    expect(classifyHead('<!DOCTYPE urlset [<!-- never closed')).toBe('not-sitemap');
    expect(classifyHead('<!DOCTYPE urlset [<?pi never closed')).toBe('not-sitemap');
    expect(classifyHead('<!DOCTYPE urlset [<!ENTITY a "b"')).toBe('not-sitemap');
    expect(classifyHead('<!DOCTYPE urlset')).toBe('not-sitemap');
    expect(classifyHead('<!FOO bar')).toBe('not-sitemap');
    expect(classifyHead('<!-- never closed')).toBe('not-sitemap');
    expect(classifyHead('<?xml version="1.0"')).toBe('not-sitemap');
    expect(classifyHead('<')).toBe('not-sitemap');
    expect(classifyHead('   ')).toBe('not-sitemap');
  });
  it('accepts a plain-text sitemap: first non-empty line is an absolute http(s) url, no markup', () => {
    expect(classifyHead('https://a.com/1\nhttps://a.com/2\n')).toBe('urlset');
    expect(classifyHead('\uFEFF\r\n  \r\nhttp://a.com/1\r\nhttp://a.com/2')).toBe('urlset');
    expect(classifyHead('https://a.com/' + 'x'.repeat(2000))).toBe('urlset'); // first line cut by the sniff window
    expect(classifyHead('https://a.com/1  \t\nhttps://a.com/2')).toBe('urlset');
    expect(classifyHead('https://a.com/1 ')).toBe('urlset');
  });
  it('rejects text, JSON and html that merely mention a url', () => {
    expect(classifyHead('Not found')).toBe('not-sitemap');
    expect(classifyHead('{"url":"https://a.com/1"}')).toBe('not-sitemap');
    expect(classifyHead('[ "https://a.com/1" ]')).toBe('not-sitemap');
    expect(classifyHead('see https://a.com/1\nhttps://a.com/2')).toBe('not-sitemap');
    expect(classifyHead('https://a.com/1 is down, sorry\n')).toBe('not-sitemap');
    expect(classifyHead('ftp://a.com/1\n')).toBe('not-sitemap');
    expect(classifyHead('')).toBe('not-sitemap');
    expect(classifyHead('<html><body>https://a.com/1</body></html>')).toBe('not-sitemap');
  });
});

describe('fetchTextStream', () => {
  it('streams plain xml and reports status, final url, redirect, last-modified and content type', async () => {
    mockFetch(byteStream(enc('<urlset>'), enc('</urlset>')), {
      url: 'https://a.com/final.xml', redirected: true, headers: { 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT', 'content-type': 'application/xml' },
    });
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    expect({ ...r, stream: undefined }).toEqual({
      ok: true, status: 200, finalUrl: 'https://a.com/final.xml', redirected: true, gzip: false,
      lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT', contentType: 'application/xml', stream: undefined,
    });
    expect(await drain(r.stream!)).toBe('<urlset></urlset>');
  });
  it('drops a Last-Modified header longer than 64 characters and keeps one of exactly 64', async () => {
    mockFetch(byteStream(enc('<urlset/>')), { headers: { 'last-modified': 'x'.repeat(65) } });
    const long = await fetchTextStream('https://a.com/sitemap.xml');
    expect(long.lastModified).toBeUndefined();
    await long.stream?.cancel();
    mockFetch(byteStream(enc('<urlset/>')), { headers: { 'last-modified': 'x'.repeat(64) } });
    const exact = await fetchTextStream('https://a.com/sitemap.xml');
    expect(exact.lastModified).toBe('x'.repeat(64));
    await exact.stream?.cancel();
  });
  it('asks for the url without credentials, following redirects, past the HTTP cache', async () => {
    mockFetch(byteStream(enc('<urlset/>')));
    await drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://a.com/sitemap.xml');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'follow', cache: 'no-store' });
  });
  it('detects gzip magic bytes and decompresses', async () => {
    const gz = gzipSync(Buffer.from('<urlset>x</urlset>'));
    mockFetch(byteStream(new Uint8Array(gz)));
    const r = await fetchTextStream('https://a.com/sitemap.xml.gz');
    expect(r.gzip).toBe(true);
    expect(await drain(r.stream!)).toBe('<urlset>x</urlset>');
  });
  it('handles gzip magic split across two chunks', async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from('<a/>')));
    mockFetch(byteStream(gz.slice(0, 1), gz.slice(1)));
    const r = await fetchTextStream('https://a.com/s.gz');
    expect(r.gzip).toBe(true);
    expect(await drain(r.stream!)).toBe('<a/>');
  });
  it('returns ok:false with status on http error', async () => {
    mockFetch(byteStream(enc('nope')), { status: 404 });
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    expect(r).toEqual({ ok: false, status: 404, finalUrl: 'https://a.com/sitemap.xml', redirected: false, gzip: false, lastModified: undefined, contentType: undefined, stream: null });
  });
  it('rejects with the network error itself', async () => {
    const failure = new TypeError('failed');
    vi.stubGlobal('fetch', vi.fn(async () => { throw failure; }));
    await expect(fetchTextStream('https://a.com/x')).rejects.toBe(failure);
  });
  it('cancels the source stream when the consumer cancels while a read is pending', async () => {
    let sourceCancelled = false;
    mockFetch(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc('<urlset>')); },
      pull() { return new Promise(() => { /* the network has nothing more */ }); },
      cancel() { sourceCancelled = true; },
    }));
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    const reader = r.stream!.getReader();
    expect((await reader.read()).value).toBe('<urlset>');
    const pending = reader.read(); // pull's read of the inner stream is now waiting on the network
    await sleep(10);
    await reader.cancel(new Error('write failed'));
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(sourceCancelled).toBe(true);
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); }); // real I/O tick: lets pending stream plumbing settle (setImmediate is not faked)

// The outcome of a promise that is still pending when the test looks at it.
function watch<T>(p: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const w: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then((v) => { w.settled = true; w.value = v; }, (e: unknown) => { w.settled = true; w.error = e; });
  return w;
}

// A fetch stub that, like the real one, errors the body (and the pending read) with the signal's reason on abort.
function slowFetch(pieces: { wait: number; data?: Uint8Array }[], seen: { signal?: AbortSignal } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const signal = init.signal!;
    seen.signal = signal;
    if (signal.aborted) throw signal.reason;
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) { signal.addEventListener('abort', () => { c.error(signal.reason); }, { once: true }); },
      async pull(c) {
        const piece = pieces[i++];
        if (!piece) { c.close(); return; }
        await sleep(piece.wait);
        if (signal.aborted) return;
        if (piece.data) c.enqueue(piece.data); else await new Promise(() => { /* stalls until aborted */ });
      },
    });
    const res = new Response(body, { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://a.com/sitemap.xml' });
    Object.defineProperty(res, 'redirected', { value: false });
    return res;
  }));
}
// A fetch whose response headers never arrive; it rejects with the signal's reason when aborted.
const hangingFetch = () => vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
  init.signal!.addEventListener('abort', () => { reject(init.signal!.reason as Error); });
})));

// Fake clock: every wait in these tests is driven by it, so each limit is checked at its exact millisecond.
describe('fetchTextStream timeouts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets a download run longer than the idle limit as long as data keeps arriving', async () => {
    slowFetch([1, 2, 3, 4, 5].map((n) => ({ wait: 40, data: enc(`<a${n}/>`) })));
    const run = fetchTextStream('https://a.com/sitemap.xml', { timeoutMs: 100 }).then((r) => drain(r.stream!)); // 200 ms in all, a 100 ms limit
    await vi.advanceTimersByTimeAsync(200);
    expect(await run).toBe('<a1/><a2/><a3/><a4/><a5/>');
  });
  it('does not count the consumer\'s own time between reads', async () => {
    slowFetch([1, 2, 3].map((n) => ({ wait: 5, data: enc(`<a${n}/>`) })));
    const run = (async () => {
      const r = await fetchTextStream('https://a.com/sitemap.xml', { timeoutMs: 60 });
      const reader = r.stream!.getReader();
      let out = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return out;
        out += value;
        await sleep(120); // twice the limit between reads
      }
    })();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toBe('<a1/><a2/><a3/>');
  });
  it('times a stalled body out with a TimeoutError exactly one idle limit after the read began', async () => {
    slowFetch([{ wait: 5, data: enc('<urlset>') }, { wait: 5 }]);
    const opened = fetchTextStream('https://a.com/sitemap.xml', { timeoutMs: 80 });
    await vi.advanceTimersByTimeAsync(5);
    const reader = (await opened).stream!.getReader();
    expect((await reader.read()).value).toBe('<urlset>');
    const stalled = watch(reader.read());
    await vi.advanceTimersByTimeAsync(79);
    expect(stalled.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalled.settled).toBe(true);
    expect(stalled.error).toMatchObject({ name: 'TimeoutError', message: 'timeout' });
  });
  it('times out with a TimeoutError exactly one idle limit after the request when the headers never come', async () => {
    hangingFetch();
    const outcome = watch(fetchTextStream('https://a.com/x', { timeoutMs: 30 }));
    await vi.advanceTimersByTimeAsync(29);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error).toMatchObject({ name: 'TimeoutError', message: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts the request and a pending read with the caller\'s own reason when its signal aborts', async () => {
    const seen: { signal?: AbortSignal } = {};
    slowFetch([{ wait: 5, data: enc('<urlset>') }, { wait: 5 }], seen);
    const outer = new AbortController();
    const opened = fetchTextStream('https://a.com/sitemap.xml', { timeoutMs: 5000, signal: outer.signal });
    await vi.advanceTimersByTimeAsync(5);
    const reader = (await opened).stream!.getReader();
    await reader.read();
    const pending = watch(reader.read());
    const reason = new DOMException('superseded', 'AbortError');
    outer.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.settled).toBe(true);
    expect(pending.error).toBe(reason);
    expect(seen.signal!.aborted).toBe(true);
    expect(seen.signal!.reason).toBe(reason);
    await vi.advanceTimersByTimeAsync(1000); // past the stub's own sleep, far short of the 5 s idle and 120 s total timers
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects with the caller\'s reason and leaves no timer when its signal is already aborted', async () => {
    slowFetch([{ wait: 1, data: enc('x') }]);
    const outer = new AbortController();
    const reason = new DOMException('superseded', 'AbortError');
    outer.abort(reason);
    await expect(fetchTextStream('https://a.com/x', { signal: outer.signal })).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fetchTextStream resources', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const signalTransport = (res: () => Response, seen: { signal?: AbortSignal }): Transport => (url, init) => {
    seen.signal = init.signal!;
    return Promise.resolve({ res: res(), finalUrl: url, redirected: false });
  };

  it('leaves no timer behind after an error status', async () => {
    mockFetch(byteStream(enc('nope')), { status: 404 });
    expect((await fetchTextStream('https://a.com/sitemap.xml')).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    mockFetch(null, { status: 500 });
    expect((await fetchTextStream('https://a.com/sitemap.xml')).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops listening to the caller\'s signal once the fetch is over, however it ended', async () => {
    const ends: [string, () => Response, (r: Awaited<ReturnType<typeof fetchTextStream>>) => Promise<unknown>][] = [
      ['an error status', () => new Response('nope', { status: 404 }), () => Promise.resolve()],
      ['a drained body', () => new Response('<urlset/>'), (r) => drain(r.stream!)],
      ['a cancelled body', () => new Response('<urlset/>'), (r) => r.stream!.cancel()],
    ];
    for (const [name, res, finish] of ends) {
      const seen: { signal?: AbortSignal } = {};
      const outer = new AbortController();
      await finish(await fetchTextStream('https://a.com/sitemap.xml', { transport: signalTransport(res, seen), signal: outer.signal }));
      expect(seen.signal!.aborted, name).toBe(false);
      outer.abort(new Error('late'));
      expect(seen.signal!.aborted, name).toBe(false);
    }
  });
  it('does not run the idle timer while the consumer has not asked for the first read', async () => {
    slowFetch([{ wait: 5, data: enc('<a1/>') }, { wait: 200, data: enc('<a2/>') }]);
    const opened = fetchTextStream('https://a.com/sitemap.xml', { timeoutMs: 60 });
    await vi.advanceTimersByTimeAsync(5);
    const r = await opened;
    await vi.advanceTimersByTimeAsync(500);
    const run = drain(r.stream!);
    await vi.advanceTimersByTimeAsync(20);
    expect(await run).toBe('<a1/><a2/>');
  });
});

describe('fetchTextStream total cap', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ends a body that drips bytes inside the idle limit exactly when the total cap passes', async () => {
    slowFetch(Array.from({ length: 100 }, (_, n) => ({ wait: 20, data: enc(`<a${n}/>`) }))); // a piece every 20 ms: never idle for 100 ms
    let reads = 0;
    const outcome = watch((async () => {
      const r = await fetchTextStream('https://a.com/sitemap.xml', { timeoutMs: 100, totalMs: 150 });
      const reader = r.stream!.getReader();
      for (;;) { const { done } = await reader.read(); if (done) return; reads++; }
    })());
    await vi.advanceTimersByTimeAsync(149);
    expect(outcome.settled).toBe(false);
    expect(reads).toBe(7); // pieces at 20, 40 ... 140 ms
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.settled).toBe(true);
    expect(outcome.error).toMatchObject({ name: 'TimeoutError', message: 'timeout' });
    expect(reads).toBe(7);
  });
  it('also ends a fetch whose headers drag past the cap, exactly at the cap', async () => {
    hangingFetch();
    const outcome = watch(fetchTextStream('https://a.com/x', { timeoutMs: 5000, totalMs: 30 }));
    await vi.advanceTimersByTimeAsync(29);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.error).toMatchObject({ name: 'TimeoutError', message: 'timeout' });
  });
  it('leaves no timer behind after a drained body, a cancelled one or a failed one', async () => {
    mockFetch(byteStream(enc('<urlset>'), enc('</urlset>')));
    const drained = await fetchTextStream('https://a.com/sitemap.xml');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // the total cap, running until the body ends
    expect(await drain(drained.stream!)).toBe('<urlset></urlset>');
    expect(vi.getTimerCount()).toBe(0);

    mockFetch(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc('<urlset>' + 'x'.repeat(1000))); } }));
    const cancelled = await fetchTextStream('https://a.com/sitemap.xml');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await cancelled.stream!.getReader().cancel();
    expect(vi.getTimerCount()).toBe(0);

    mockFetch(new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError('boom')); } }));
    await expect(fetchTextStream('https://a.com/x')).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('gives a sniff a 30 s total cap of its own, whatever the idle limit', async () => {
    slowFetch([{ wait: 1, data: enc('<urlset ') }, { wait: 1 }]);
    const sniff = watch(sniffSitemap('https://a.com/sitemap.xml', { timeoutMs: 600_000 }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sniff.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sniff.settled).toBe(true);
    expect(sniff.value).toEqual({ sniff: 'network-error' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('gives a sniff its own 15 s idle limit', async () => {
    hangingFetch();
    const sniff = watch(sniffSitemap('https://a.com/sitemap.xml'));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sniff.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sniff.value).toEqual({ sniff: 'network-error' });
  });
});

describe('fetchTextStream encoding', () => {
  const utf16le = (s: string) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xff; b[1] = 0xfe; for (let i = 0; i < s.length; i++) b[2 + i * 2] = s.charCodeAt(i); return b; };
  const utf16be = (s: string) => { const b = new Uint8Array(2 + s.length * 2); b[0] = 0xfe; b[1] = 0xff; for (let i = 0; i < s.length; i++) b[3 + i * 2] = s.charCodeAt(i); return b; };

  it('fails a UTF-16LE body with NotUtf8Error naming UTF-16', async () => {
    mockFetch(byteStream(utf16le('<urlset></urlset>')));
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    expect(r.ok).toBe(true);
    const failure = await drain(r.stream!).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotUtf8Error);
    expect((failure as NotUtf8Error).encoding).toBe('UTF-16');
  });
  it('fails a UTF-16BE body, also when the first chunk is a single byte', async () => {
    const b = utf16be('<urlset></urlset>');
    mockFetch(byteStream(b.slice(0, 1), b.slice(1, 3), b.slice(3)));
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    await expect(drain(r.stream!)).rejects.toMatchObject({ encoding: 'UTF-16' });
  });
  it('fails a UTF-32 body naming UTF-32', async () => {
    mockFetch(byteStream(new Uint8Array([0xff, 0xfe, 0, 0, 0x3c, 0, 0, 0])));
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    await expect(drain(r.stream!)).rejects.toMatchObject({ encoding: 'UTF-32' });
    mockFetch(byteStream(new Uint8Array([0, 0, 0xfe, 0xff, 0, 0, 0, 0x3c])));
    const r2 = await fetchTextStream('https://a.com/sitemap.xml');
    await expect(drain(r2.stream!)).rejects.toMatchObject({ encoding: 'UTF-32' });
  });
  it('detects the mark inside a gzip body too', async () => {
    mockFetch(byteStream(new Uint8Array(gzipSync(Buffer.from(utf16le('<urlset></urlset>'))))));
    const r = await fetchTextStream('https://a.com/sitemap.xml.gz');
    expect(r.gzip).toBe(true);
    await expect(drain(r.stream!)).rejects.toMatchObject({ encoding: 'UTF-16' });
  });
  it('stops pulling the body once the mark is found', async () => {
    let pulls = 0;
    mockFetch(new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(pulls === 1 ? utf16le('<urlset>') : new Uint8Array(1024)); } }));
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    await expect(drain(r.stream!)).rejects.toBeInstanceOf(NotUtf8Error);
    await flush();
    const settled = pulls;
    await flush(); await flush();
    expect(pulls).toBe(settled); // nothing keeps reading an endless body
    expect(settled).toBeLessThanOrEqual(3); // the first chunk plus the read-ahead of the streams in the chain; the depth varies by Node version
  });
  it('names the encoding in the error message', async () => {
    mockFetch(byteStream(utf16le('<urlset></urlset>')));
    const failure = await drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'NotUtf8Error', message: 'not UTF-8 (UTF-16)' });
  });
  it('tells UTF-16 from UTF-32 by the third and fourth byte', async () => {
    mockFetch(byteStream(new Uint8Array([0xff, 0xfe, 0, 0x41, 0, 0x42])));
    await expect(drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!)).rejects.toMatchObject({ encoding: 'UTF-16' });
    mockFetch(byteStream(new Uint8Array([0xff, 0xfe, 0x41, 0])));
    await expect(drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!)).rejects.toMatchObject({ encoding: 'UTF-16' });
    mockFetch(byteStream(new Uint8Array([0xff, 0xfe, 0])));
    await expect(drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!)).rejects.toMatchObject({ encoding: 'UTF-16' });
  });
  it('reads a body whose first bytes only resemble a byte order mark as UTF-8', async () => {
    for (const bytes of [
      [0xff, 0x41, 0x42, 0x43], [0x41, 0xfe, 0x42, 0x43], [0xfe, 0x41, 0x42, 0x43], [0x41, 0xff, 0x42, 0x43],
      [0, 0, 0xfe, 0x41], [0, 0, 0x41, 0xff], [0, 0x41, 0xfe, 0xff], [0x41, 0, 0xfe, 0xff], [0x41, 0x42, 0xfe, 0x43], [0, 0x41, 0x42, 0x43],
    ]) {
      const body = new Uint8Array(bytes);
      mockFetch(byteStream(body));
      expect(await drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!), bytes.join()).toBe(new TextDecoder().decode(body));
    }
  });
  it('looks for the mark in the first bytes only, not at the start of a later chunk', async () => {
    const later = new Uint8Array([0xff, 0xfe, 0x41, 0x42]);
    mockFetch(byteStream(enc('<a/>'), later));
    expect(await drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!)).toBe(`<a/>${new TextDecoder().decode(later)}`);
    mockFetch(byteStream(enc('<'), enc('a/'), enc('>'), later));
    expect(await drain((await fetchTextStream('https://a.com/sitemap.xml')).stream!)).toBe(`<a/>${new TextDecoder().decode(later)}`);
  });
  it('does not take a body for gzip unless both magic bytes match', async () => {
    for (const bytes of [[0x41, 0x8b, 0x42, 0x43], [0x1f, 0x41, 0x42, 0x43], [0x8b, 0x1f, 0x42, 0x43], [0x1f]]) {
      const body = new Uint8Array(bytes);
      mockFetch(byteStream(body));
      const r = await fetchTextStream('https://a.com/sitemap.xml');
      expect(r.gzip, bytes.join()).toBe(false);
      expect(await drain(r.stream!)).toBe(new TextDecoder().decode(body));
    }
  });
  it('fails a body that is only a byte order mark and nothing else', async () => {
    mockFetch(byteStream(new Uint8Array([0xff, 0xfe])));
    const r = await fetchTextStream('https://a.com/sitemap.xml');
    await expect(drain(r.stream!)).rejects.toMatchObject({ encoding: 'UTF-16' });
  });
  it('still reads UTF-8 with a byte order mark and short bodies', async () => {
    mockFetch(byteStream(new Uint8Array([0xef, 0xbb, 0xbf]), enc('<a/>')));
    expect(await drain((await fetchTextStream('https://a.com/s.xml')).stream!)).toBe('<a/>');
    mockFetch(byteStream(enc('<a')));
    expect(await drain((await fetchTextStream('https://a.com/s.xml')).stream!)).toBe('<a');
    mockFetch(byteStream(enc('<')));
    expect(await drain((await fetchTextStream('https://a.com/s.xml')).stream!)).toBe('<');
  });
  it('lets a sniff report a UTF-16 body as not-utf8 with its encoding', async () => {
    mockFetch(byteStream(utf16le('<urlset></urlset>')));
    expect(await sniffSitemap('https://a.com/sitemap.xml')).toEqual({ sniff: 'not-utf8', encoding: 'UTF-16' });
  });
});

describe('sniffSitemap', () => {
  it('sniffs a urlset with its response details, without reading the whole body', async () => {
    let pulls = 0; let cancelled = false;
    // an endless body: a sniff that read it all would never return
    mockFetch(new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(enc(pulls === 1 ? '<?xml version="1.0"?><urlset xmlns="ns">' : '<url><loc>https://a.com/x</loc></url>'.repeat(100))); },
      cancel() { cancelled = true; },
    }), { url: 'https://a.com/final.xml', redirected: true, headers: { 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT', 'content-type': 'text/xml' } });
    expect(await sniffSitemap('https://a.com/sitemap.xml')).toEqual({
      sniff: 'urlset', status: 200, finalUrl: 'https://a.com/final.xml', redirected: true, gzip: false, lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT', contentType: 'text/xml', size: null,
    });
    await vi.waitFor(() => { expect(cancelled).toBe(true); });
    expect(pulls).toBeGreaterThanOrEqual(2);
    expect(pulls).toBeLessThanOrEqual(6); // the head, then the read-ahead of the streams in the chain; the depth varies by Node version
  });
  it('sniffs a sitemapindex', async () => {
    mockFetch(byteStream(enc('<?xml version="1.0"?><sitemapindex xmlns="ns"><sitemap/></sitemapindex>')));
    expect((await sniffSitemap('https://a.com/sitemap.xml')).sniff).toBe('sitemapindex');
  });
  it('sniffs a text sitemap whatever the content type', async () => {
    for (const type of ['text/plain', 'application/octet-stream', 'text/html']) {
      mockFetch(byteStream(enc('https://a.com/1\nhttps://a.com/2\n')), { headers: { 'content-type': type } });
      expect(await sniffSitemap('https://a.com/sitemap.txt')).toMatchObject({ sniff: 'urlset', contentType: type, gzip: false });
    }
  });
  it('sniffs a gzipped text sitemap', async () => {
    mockFetch(byteStream(new Uint8Array(gzipSync('https://a.com/1\nhttps://a.com/2\n'))), { headers: { 'content-type': 'application/gzip' } });
    expect(await sniffSitemap('https://a.com/sitemap.txt.gz')).toMatchObject({ sniff: 'urlset', gzip: true, contentType: 'application/gzip' });
  });
  it('rejects a plain-text not-found page and a JSON error body', async () => {
    mockFetch(byteStream(enc('Not found')), { headers: { 'content-type': 'text/plain' } });
    expect((await sniffSitemap('https://a.com/sitemap.txt')).sniff).toBe('not-sitemap');
    mockFetch(byteStream(enc('{"error":"not found","url":"https://a.com/sitemap.txt"}')), { headers: { 'content-type': 'application/json' } });
    expect((await sniffSitemap('https://a.com/sitemap.txt')).sniff).toBe('not-sitemap');
  });
  it('classifies html soft-404 as not-sitemap', async () => {
    mockFetch(byteStream(enc('<!DOCTYPE html><html><body>welcome</body></html>')));
    expect((await sniffSitemap('https://a.com/sitemap.xml')).sniff).toBe('not-sitemap');
  });
  it('maps http and network failures', async () => {
    mockFetch(null, { status: 500 });
    expect(await sniffSitemap('https://a.com/x')).toEqual({ sniff: 'http-error', status: 500, finalUrl: 'https://a.com/sitemap.xml', redirected: false, gzip: false, lastModified: undefined, contentType: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    expect(await sniffSitemap('https://a.com/x')).toEqual({ sniff: 'network-error' });
  });
  it('cancels the body and clears its timers once the sniff has what it needs, though the body never ends', async () => {
    vi.useFakeTimers();
    try {
      const upstreamCancel = vi.fn();
      mockFetch(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc('<urlset>' + 'x'.repeat(10000))); }, cancel: upstreamCancel }));
      expect((await sniffSitemap('https://a.com/sitemap.xml', { timeoutMs: 100 })).sniff).toBe('urlset');
      await vi.advanceTimersByTimeAsync(0);
      expect(upstreamCancel).toHaveBeenCalledTimes(1); // the cancel travels through the stream chain to the network body
      expect(vi.getTimerCount()).toBe(0); // not only an EOF clears the timers
    } finally { vi.useRealTimers(); }
  });
  it('returns network-error when the body fails mid-read (corrupt gzip)', async () => {
    mockFetch(byteStream(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])));
    expect((await sniffSitemap('https://a.com/sitemap.xml')).sniff).toBe('network-error');
  });
  it('returns network-error when the body errors after the first chunk', async () => {
    let sent = false;
    mockFetch(new ReadableStream<Uint8Array>({ pull(c) { if (sent) c.error(new TypeError('stalled')); else { sent = true; c.enqueue(enc('<?xml version="1.0"?>')); } } }));
    expect((await sniffSitemap('https://a.com/sitemap.xml')).sniff).toBe('network-error');
  });
  it('clears its timers when the first read of the body rejects', async () => {
    vi.useFakeTimers();
    try {
      mockFetch(new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError('boom')); } }));
      await expect(fetchTextStream('https://a.com/x')).rejects.toThrow('boom');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

// A server that answers Range requests: handler gets the Range header (null when the request had none) and the url.
function rangeServer(handler: (range: string | null, url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const res = await handler(new Headers(init.headers).get('range'), url);
    Object.defineProperty(res, 'url', { value: url });
    Object.defineProperty(res, 'redirected', { value: false });
    return res;
  }));
}
const partial = (body: BodyInit | null, contentRange: string, extra: Record<string, string> = {}) =>
  new Response(body, { status: 206, headers: { 'content-range': contentRange, ...extra } });
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + '<url><loc>https://a.com/page</loc></url>'.repeat(60);
const randomSitemap = (n: number) => '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + Array.from({ length: n }, (_, i) => `<url><loc>https://a.com/${(i * 7919).toString(36)}-${(i * 104729).toString(36)}</loc></url>`).join('') + '</urlset>';
const rangeOf = (call: number): string | null => new Headers(vi.mocked(fetch).mock.calls[call]![1]!.headers).get('range');

describe('sniffSitemap size', () => {
  it('sends a ranged GET for the first 2,048 bytes and reads the file size from Content-Range', async () => {
    rangeServer(() => partial(XML_HEAD.slice(0, 2048), 'bytes 0-2047/52428800', { 'content-type': 'application/xml' }));
    expect(await sniffSitemap('https://a.com/big.xml')).toEqual({
      sniff: 'urlset', status: 200, finalUrl: 'https://a.com/big.xml', redirected: false, gzip: false, lastModified: undefined, contentType: 'application/xml', size: 52_428_800,
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(rangeOf(0)).toBe('bytes=0-2047');
    expect(vi.mocked(fetch).mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'follow', cache: 'no-store' });
  });
  it('gives null for a total of * (the server does not know it), and for a 206 without a usable Content-Range', async () => {
    rangeServer(() => partial(XML_HEAD.slice(0, 2048), 'bytes 0-2047/*'));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
    rangeServer(() => new Response(XML_HEAD.slice(0, 2048), { status: 206 }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
    rangeServer(() => partial(XML_HEAD.slice(0, 2048), 'bytes 0-2047/12x'));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
  });
  it('reads a Content-Range with extra spaces, zero padding or non-ASCII outer whitespace', async () => {
    for (const range of ['bytes  0-2047/9000', 'bytes 00-2047/9000', '\u00a0bytes 0-2047/9000\u00a0']) {
      rangeServer(() => partial(XML_HEAD.slice(0, 2048), range));
      expect(await sniffSitemap('https://a.com/s.xml'), range).toMatchObject({ sniff: 'urlset', size: 9000 });
      expect(vi.mocked(fetch), range).toHaveBeenCalledTimes(1);
    }
  });
  it('takes only a plain run of digits for a Content-Length, after trimming', async () => {
    for (const length of ['-5', '1e3', '0x10', '12x', '1 2', '', '1'.repeat(16)]) {
      rangeServer(() => new Response(XML_HEAD, { status: 200, headers: { 'content-length': length } }));
      expect((await sniffSitemap('https://a.com/s.xml')).size, length).toBeNull();
    }
    rangeServer(() => new Response(XML_HEAD, { status: 200, headers: { 'content-length': '\u00a04096\u00a0' } }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBe(4096);
    rangeServer(() => new Response(XML_HEAD, { status: 200, headers: { 'content-length': '0' } }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBe(0);
  });
  it('passes a 2xx status other than 200 through', async () => {
    rangeServer(() => new Response(XML_HEAD, { status: 202 }));
    expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'urlset', status: 202 });
  });
  it('cancels the body after the head, though the server ignored the range and sends the whole file', async () => {
    let cancelled = false;
    let pulls = 0;
    rangeServer(() => new Response(new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(enc(pulls === 1 ? XML_HEAD : '<url><loc>https://a.com/x</loc></url>'.repeat(200))); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-length': '123456789' } }));
    const r = await sniffSitemap('https://a.com/s.xml');
    expect(r).toMatchObject({ sniff: 'urlset', status: 200, size: 123_456_789 });
    await vi.waitFor(() => { expect(cancelled).toBe(true); });
  });
  it('takes Content-Length of a 200 as the size when there is no Content-Encoding (or identity)', async () => {
    rangeServer(() => new Response(XML_HEAD, { status: 200, headers: { 'content-length': '4096' } }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBe(4096);
    rangeServer(() => new Response(enc(XML_HEAD.slice(0, 100)), { status: 200, headers: { 'content-length': '100', 'content-encoding': 'identity' } }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBe(100);
  });
  it('gives null for a 200 with a Content-Encoding (the length is the encoded one), or without a length', async () => {
    rangeServer(() => new Response(enc(XML_HEAD.slice(0, 100)), { status: 200, headers: { 'content-length': '100', 'content-encoding': 'br' } }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
    rangeServer(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(XML_HEAD)); c.close(); } }), { status: 200 }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
  });
  it('gives null for a 206 with a Content-Encoding (its Content-Range counts encoded bytes)', async () => {
    rangeServer(() => partial(XML_HEAD.slice(0, 2048), 'bytes 0-866/867', { 'content-encoding': 'br' }));
    expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'urlset', status: 200, size: null });
    rangeServer(() => partial(XML_HEAD.slice(0, 2048), 'bytes 0-2047/18715', { 'content-encoding': 'identity' }));
    expect((await sniffSitemap('https://a.com/s.xml')).size).toBe(18_715);
  });
  it('falls back to one plain GET on 416 (an empty file) and says size 0 for an empty body', async () => {
    rangeServer((range) => (range ? new Response(null, { status: 416 }) : new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200 })));
    expect(await sniffSitemap('https://a.com/empty.xml')).toMatchObject({ sniff: 'not-sitemap', status: 200, size: 0 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(rangeOf(0)).toBe('bytes=0-2047');
    expect(rangeOf(1)).toBeNull();
  });
  it('asks again only once: a plain GET that answers 416 or an unusable 206 itself is the answer', async () => {
    rangeServer(() => new Response(null, { status: 416 }));
    expect(await sniffSitemap('https://a.com/x.xml')).toMatchObject({ sniff: 'http-error', status: 416 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    rangeServer(() => new Response(XML_HEAD.slice(0, 2048), { status: 206, headers: { 'content-range': 'bytes 100-2047/9000' } }));
    expect(await sniffSitemap('https://a.com/x.xml')).toMatchObject({ sniff: 'urlset', status: 200, size: null });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
  it('says size 0 for an empty body only when a 416 refused the range', async () => {
    const empty = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200 });
    rangeServer(() => empty());
    expect(await sniffSitemap('https://a.com/empty.xml')).toMatchObject({ sniff: 'not-sitemap', status: 200, size: null });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    rangeServer((range) => (range === null ? empty() : new Response(XML_HEAD.slice(0, 2048), { status: 206, headers: { 'content-range': 'bytes 100-2047/9000' } })));
    expect(await sniffSitemap('https://a.com/empty.xml')).toMatchObject({ sniff: 'not-sitemap', size: null });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
  it('does not say size 0 for a plain GET that has a body but no length after a 416', async () => {
    rangeServer((range) => (range === null ? new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc('<urlset/>')); c.close(); } }), { status: 200 }) : new Response(null, { status: 416 })));
    expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'urlset', size: null });
  });
  it('asks only once more for a head the range cut: a reread that answers 416 or a 206 is the answer', async () => {
    const cutHead = () => partial('<?xml version="1.0"?><!-- short -->', 'bytes 0-9/*');
    rangeServer((range) => (range ? cutHead() : new Response(null, { status: 416 })));
    expect(await sniffSitemap('https://a.com/x.xml')).toMatchObject({ sniff: 'http-error', status: 416 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    rangeServer((range) => (range ? cutHead() : partial('<?xml version="1.0"?><!-- short -->', 'bytes 0-9/*')));
    expect(await sniffSitemap('https://a.com/x.xml')).toMatchObject({ sniff: 'not-sitemap', status: 200 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
  it('trusts the Content-Length of the plain GET over the empty body a 416 implies', async () => {
    rangeServer((range) => (range === null
      ? new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), { status: 200, headers: { 'content-length': '5' } })
      : new Response(null, { status: 416 })));
    expect(await sniffSitemap('https://a.com/empty.xml')).toMatchObject({ sniff: 'not-sitemap', size: 5 });
  });
  it('maps a 416 that the plain GET also fails to an http-error, and keeps the usual failures', async () => {
    rangeServer((range) => new Response(null, { status: range ? 416 : 404 }));
    expect(await sniffSitemap('https://a.com/x.xml')).toMatchObject({ sniff: 'http-error', status: 404 });
    rangeServer(() => new Response(null, { status: 429 }));
    expect(await sniffSitemap('https://a.com/x.xml')).toMatchObject({ sniff: 'http-error', status: 429 });
  });

  describe('a gzip file', () => {
    const doc = randomSitemap(3000);
    const gz = new Uint8Array(gzipSync(doc));
    const isize = new Uint8Array(gz.buffer, gz.byteOffset + gz.length - 4, 4);
    it('classifies the decompressed head and reads the uncompressed size from the gzip trailer with a second ranged request', async () => {
      expect(gz.length).toBeGreaterThan(2048);
      rangeServer((range) => (range === 'bytes=-4'
        ? partial(isize.slice(), `bytes ${gz.length - 4}-${gz.length - 1}/${gz.length}`)
        : partial(gz.slice(0, 2048), `bytes 0-2047/${gz.length}`)));
      const r = await sniffSitemap('https://a.com/sitemap.xml.gz');
      expect(r).toMatchObject({ sniff: 'urlset', gzip: true, size: new TextEncoder().encode(doc).length });
      expect(r.sizeCompressed).toBeUndefined();
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(rangeOf(1)).toBe('bytes=-4');
      expect(vi.mocked(fetch).mock.calls[1]![1]).toMatchObject({ credentials: 'omit', redirect: 'follow', cache: 'no-store' });
    });
    it('falls back to the compressed size, flagged, when the trailer request does not answer 206 with 4 bytes', async () => {
      for (const trailer of [() => new Response(gz.slice(), { status: 200 }), () => partial(new Uint8Array(3), 'bytes 0-2/9'), () => partial(new Uint8Array(5), 'bytes 0-4/9')]) {
        rangeServer((range) => (range === 'bytes=-4' ? trailer() : partial(gz.slice(0, 2048), `bytes 0-2047/${gz.length}`)));
        expect(await sniffSitemap('https://a.com/sitemap.xml.gz')).toMatchObject({ sniff: 'urlset', gzip: true, size: gz.length, sizeCompressed: true });
      }
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
        if (new Headers(init.headers).get('range') === 'bytes=-4') throw new TypeError('failed');
        const res = partial(gz.slice(0, 2048), `bytes 0-2047/${gz.length}`);
        Object.defineProperty(res, 'url', { value: 'https://a.com/sitemap.xml.gz' });
        return res;
      }));
      expect(await sniffSitemap('https://a.com/sitemap.xml.gz')).toMatchObject({ size: gz.length, sizeCompressed: true });
    });
    it('sends no trailer request to the origin a redirect ended on, and keeps the compressed size', async () => {
      const seen: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        seen.push(url);
        const res = partial(gz.slice(0, 2048), `bytes 0-2047/${gz.length}`);
        Object.defineProperty(res, 'url', { value: 'http://192.168.1.10/s.xml.gz' });
        Object.defineProperty(res, 'redirected', { value: true });
        return res;
      }));
      const r = await sniffSitemap('https://a.com/s.xml.gz');
      expect(seen).toEqual(['https://a.com/s.xml.gz']);
      expect(r).toMatchObject({ sniff: 'urlset', gzip: true, redirected: true, size: gz.length, sizeCompressed: true });
    });
    it('still asks for the trailer after a redirect within the same origin', async () => {
      const seen: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        seen.push(url);
        const trailer = new Headers(init.headers).get('range') === 'bytes=-4';
        const res = trailer ? partial(isize.slice(), `bytes ${gz.length - 4}-${gz.length - 1}/${gz.length}`) : partial(gz.slice(0, 2048), `bytes 0-2047/${gz.length}`);
        Object.defineProperty(res, 'url', { value: 'https://a.com/final.xml.gz' });
        Object.defineProperty(res, 'redirected', { value: true });
        return res;
      }));
      const r = await sniffSitemap('https://a.com/s.xml.gz');
      expect(seen).toEqual(['https://a.com/s.xml.gz', 'https://a.com/final.xml.gz']);
      expect(r.sizeCompressed).toBeUndefined();
      expect(r.size).toBe(new TextEncoder().encode(doc).length);
    });
    it('still asks for the trailer when the head gave no size, and has no size when that fails too', async () => {
      rangeServer((range) => (range === 'bytes=-4' ? partial(isize.slice(), 'bytes 1-4/5') : partial(gz.slice(0, 2048), 'bytes 0-2047/*')));
      expect((await sniffSitemap('https://a.com/s.xml.gz')).size).toBe(new TextEncoder().encode(doc).length);
      rangeServer((range) => (range === 'bytes=-4' ? new Response(null, { status: 416 }) : partial(gz.slice(0, 2048), 'bytes 0-2047/*')));
      const r = await sniffSitemap('https://a.com/s.xml.gz');
      expect(r.size).toBeNull();
      expect(r.sizeCompressed).toBeUndefined();
    });
    it('reads a gzip file that fits the range whole, and trusts "not a sitemap" for it', async () => {
      const small = new Uint8Array(gzipSync('<html><body>nope</body></html>'));
      rangeServer((range) => (range === 'bytes=-4' ? partial(small.slice(-4), `bytes ${small.length - 4}-${small.length - 1}/${small.length}`) : partial(small.slice(), `bytes 0-${small.length - 1}/${small.length}`)));
      expect(await sniffSitemap('https://a.com/x.gz')).toMatchObject({ sniff: 'not-sitemap', gzip: true, size: '<html><body>nope</body></html>'.length });
    });
    it('fails a ranged gzip head that errors before anything was inflated', async () => {
      rangeServer(() => partial(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(gz.slice(0, 2)); },
        pull() { return new Promise((resolve) => { setTimeout(resolve, 5); }).then(() => { throw new TypeError('unexpected end of file'); }); },
      }), `bytes 0-2047/${gz.length}`));
      expect(await sniffSitemap('https://a.com/s.xml.gz')).toEqual({ sniff: 'network-error' });
    });
    it('keeps what was inflated when the cut-off stream ends in an error', async () => {
      const cut = gz.slice(0, 150); // inflates to well under the 2,048-character head, so the read reaches the error
      rangeServer((range) => (range === 'bytes=-4' ? partial(isize.slice(), 'bytes 1-4/5') : partial(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(cut); },
        pull() { return new Promise((resolve) => { setTimeout(resolve, 20); }).then(() => { throw new TypeError('unexpected end of file'); }); },
      }), `bytes 0-2047/${gz.length}`)));
      expect(await sniffSitemap('https://a.com/s.xml.gz')).toMatchObject({ sniff: 'urlset', gzip: true });
    });
  });

  describe('a head the range cut inside a prolog', () => {
    const SITEMAP = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.com/</loc></url></urlset>';
    // honours the range like a real server: bytes 0-2047 of the file as UTF-8, a plain GET gets all of it
    const honouring = (doc: string) => rangeServer((range) => {
      const bytes = enc(doc);
      return range === null ? new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }) : partial(bytes.slice(0, 2048), `bytes 0-${Math.min(2047, bytes.length - 1)}/${bytes.length}`);
    });
    it('reads a 3 KB ASCII comment before <urlset> with one more plain GET and says urlset', async () => {
      honouring(`<?xml version="1.0"?><!-- ${'x'.repeat(3000)} -->\n${SITEMAP}`);
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'urlset', status: 200, size: enc(`<?xml version="1.0"?><!-- ${'x'.repeat(3000)} -->\n${SITEMAP}`).length });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    it('reads a Cyrillic comment with <urlset at character ~1,460 (2,700+ bytes) as urlset, and keeps the size of the ranged answer', async () => {
      const doc = `<?xml version="1.0"?><!-- ${'п'.repeat(1400)} -->\n${SITEMAP}`;
      expect(enc(doc.slice(0, doc.indexOf('<urlset'))).length).toBeGreaterThan(2700);
      honouring(doc);
      const r = await sniffSitemap('https://a.com/s.xml');
      expect(r).toMatchObject({ sniff: 'urlset', size: enc(doc).length });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(rangeOf(0)).toBe('bytes=0-2047');
      expect(rangeOf(1)).toBeNull();
    });
    it('reads again for every kind of cut head: a comment, a processing instruction, a DOCTYPE, whitespace, the root name', async () => {
      for (const prolog of [`<!-- ${'x'.repeat(2500)} -->`, `<?pi ${'x'.repeat(2500)}?>`, `<!DOCTYPE urlset [${'<!ENTITY a "b">'.repeat(180)}]>`, ' '.repeat(2100)]) {
        honouring(`<?xml version="1.0"?>${prolog}${SITEMAP}`);
        await sniffSitemap('https://a.com/s.xml');
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      }
      honouring(`${' '.repeat(2042)}${SITEMAP}`); // the range ends inside the root name
      await sniffSitemap('https://a.com/s.xml');
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    it('says what a cut head is once the plain GET has read it, for each kind of prolog', async () => {
      for (const prolog of [
        `<!DOCTYPE urlset [<!-- ${'x'.repeat(2500)} -->]>`, `<!DOCTYPE urlset [<?pi ${'x'.repeat(2500)}?>]>`, `<!FOO ${'x'.repeat(2500)}>`,
        `<!DOCTYPE urlset [<!ENTITY a "${'x'.repeat(2500)}">]>`, '<!-->'.repeat(500),
      ]) {
        honouring(`${prolog}${SITEMAP}`);
        expect((await sniffSitemap('https://a.com/s.xml')).sniff, prolog.slice(0, 20)).toBe('urlset');
        expect(vi.mocked(fetch), prolog.slice(0, 20)).toHaveBeenCalledTimes(2);
      }
    });
    it('reads again for a head that is only white space, and for one that ends on the < of the root', async () => {
      honouring(`${' '.repeat(2100)}${SITEMAP}`);
      expect((await sniffSitemap('https://a.com/s.xml')).sniff).toBe('urlset');
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      honouring(`<?xml version="1.0"?>${' '.repeat(2026)}${SITEMAP}`);
      expect((await sniffSitemap('https://a.com/s.xml')).sniff).toBe('urlset');
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    it('does not read again for a head that ends on a character that cannot start a root', async () => {
      rangeServer(() => partial(`<?xml version="1.0"?>${' '.repeat(2026)}x`, 'bytes 0-2047/9000'));
      expect((await sniffSitemap('https://a.com/s.xml')).sniff).toBe('not-sitemap');
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
    it('reads again when a head the whole file fits in is not known to be the whole file', async () => {
      rangeServer((range) => (range === null ? new Response('<!-- c --><urlset/>', { status: 200 }) : partial('<!-- c -->', 'bytes 0-9/*')));
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'urlset', size: null });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    it('takes a head the ranged answer filled to the last byte of the file as complete, though it holds fewer than 2,048 characters', async () => {
      const doc = `<!-- ${'п'.repeat(1000)} -->${' '.repeat(39)}`;
      expect(enc(doc).length).toBe(2048);
      rangeServer(() => partial(enc(doc), 'bytes 0-2047/2048'));
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'not-sitemap', size: 2048 });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
    it('cannot tell a head of exactly 2,048 characters from the end of the file, so it reads again', async () => {
      const doc = `<!-- ${'x'.repeat(2039)} -->`;
      expect(doc.length).toBe(2048);
      rangeServer((range) => (range === null ? new Response(doc, { status: 200 }) : partial(doc, 'bytes 0-2047/2048')));
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'not-sitemap', size: 2048 });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    it('gives a plain 200 whose cut head runs on past the window the verdict of that head, without a second request', async () => {
      rangeServer(() => new Response(byteStream(enc(`<?xml version="1.0"?><!-- ${'x'.repeat(2100)}`), enc(` -->${SITEMAP}`)), { status: 200 }));
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'not-sitemap', status: 200, size: null });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
    it('uses the size of the plain GET when the ranged answer had none', async () => {
      rangeServer((range) => (range === null ? new Response(`<?xml version="1.0"?><!-- ${'x'.repeat(1900)} -->${SITEMAP}`, { status: 200, headers: { 'content-length': '5000' } }) : partial(`<?xml version="1.0"?><!-- ${'x'.repeat(2100)}`.slice(0, 2048), 'bytes 0-2047/*')));
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'urlset', size: 5000 });
    });
    it('gives the error of the plain GET when it fails', async () => {
      rangeServer((range) => (range === null ? new Response(null, { status: 500 }) : partial(`<!-- ${'x'.repeat(2100)}`.slice(0, 2048), 'bytes 0-2047/9000')));
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'http-error', status: 500 });
    });
    it('does not read again when the whole file fit the range, or a root element was seen', async () => {
      rangeServer(() => partial('<!-- just a comment -->', 'bytes 0-22/23'));
      expect((await sniffSitemap('https://a.com/s.xml')).sniff).toBe('not-sitemap');
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      rangeServer(() => partial(`<html>${' '.repeat(2042)}`, 'bytes 0-2047/60000'));
      expect((await sniffSitemap('https://a.com/s.xml')).sniff).toBe('not-sitemap');
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
      rangeServer(() => new Response('<!-- just a comment -->', { status: 200 }));
      expect((await sniffSitemap('https://a.com/s.xml')).sniff).toBe('not-sitemap');
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
    it('still reads a urlset after a prolog that fits the head', async () => {
      rangeServer(() => partial(`<?xml version="1.0"?><!-- ${'x'.repeat(100)} -->\n<urlset xmlns="x">${' '.repeat(1800)}`, 'bytes 0-2047/60000'));
      expect((await sniffSitemap('https://a.com/s.xml')).sniff).toBe('urlset');
    });
  });

  describe('an answer that is not the head asked for', () => {
    const body = XML_HEAD.slice(0, 2048);
    it.each([
      ['starts after byte 0', 'bytes 100-2047/9000'],
      ['runs past the range', 'bytes 0-4095/9000'],
      ['runs past the range by one byte', 'bytes 0-2048/9000'],
      ['is wrapped in other text', 'xbytes 0-2047/9000'],
      ['has no Content-Range', ''],
    ])('a 206 that %s is dropped: no size from it, the file is read with one plain GET', async (_name, range) => {
      rangeServer((asked) => (asked === null ? new Response(XML_HEAD, { status: 200 }) : new Response(body, { status: 206, headers: range ? { 'content-range': range } : {} })));
      const r = await sniffSitemap('https://a.com/s.xml');
      expect(r).toMatchObject({ sniff: 'urlset', status: 200, size: null });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      expect(rangeOf(1)).toBeNull();
    });
    it('takes the range end as given: 0-2047 is the longest accepted', async () => {
      rangeServer(() => partial(body, 'bytes 0-2047/9000'));
      expect(await sniffSitemap('https://a.com/s.xml')).toMatchObject({ sniff: 'urlset', size: 9000 });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
  });

  describe('hostile sizes', () => {
    it('drops a Content-Range total or a Content-Length above 2^40', async () => {
      rangeServer(() => partial(XML_HEAD.slice(0, 2048), `bytes 0-2047/${2 ** 40 + 1}`));
      expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
      rangeServer(() => partial(XML_HEAD.slice(0, 2048), `bytes 0-2047/${2 ** 40}`));
      expect((await sniffSitemap('https://a.com/s.xml')).size).toBe(2 ** 40);
      rangeServer(() => new Response(XML_HEAD, { status: 200, headers: { 'content-length': String(2 ** 40 + 1) } }));
      expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
      rangeServer(() => partial(XML_HEAD.slice(0, 2048), 'bytes 0-2047/99999999999999999999'));
      expect((await sniffSitemap('https://a.com/s.xml')).size).toBeNull();
    });
  });

  it('reports a 206 as 200', async () => {
    rangeServer(() => partial(XML_HEAD.slice(0, 2048), 'bytes 0-2047/9000'));
    expect((await sniffSitemap('https://a.com/s.xml')).status).toBe(200);
  });
});

describe('mediaType', () => {
  it('lowercases and drops parameters', () => {
    expect(mediaType('Text/HTML; charset=UTF-8')).toBe('text/html');
    expect(mediaType(' application/rss+xml ')).toBe('application/rss+xml');
  });
  it('drops missing, oversized or malformed values', () => {
    expect(mediaType(undefined)).toBeUndefined();
    expect(mediaType('')).toBeUndefined();
    expect(mediaType(`application/${'x'.repeat(200)}`)).toBeUndefined();
    expect(mediaType(`application/${'x'.repeat(88)}`)).toBe(`application/${'x'.repeat(88)}`); // 100 characters: the longest kept
    expect(mediaType(`application/${'x'.repeat(89)}`)).toBeUndefined(); // 101
    expect(mediaType('<script>alert(1)</script>')).toBeUndefined();
    expect(mediaType('text')).toBeUndefined();
    expect(mediaType('foo bar/baz')).toBeUndefined();
    expect(mediaType('text/html foo')).toBeUndefined();
  });
});
