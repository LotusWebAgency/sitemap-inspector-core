import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultTransport, fetchTextStream, sniffSitemap, type Transport } from './fetcher.js';
import { COMMON_PATHS, discoverSitemaps } from './discovery.js';
import { fetchRobots } from './robots.js';

const URLSET = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>';
const stub = (res: () => Response, extra: { finalUrl?: string; redirected?: boolean } = {}) =>
  vi.fn<Transport>(async (url) => ({ res: res(), finalUrl: extra.finalUrl ?? url, redirected: extra.redirected ?? false }));
function watch<T>(p: Promise<T>): { settled: boolean; value?: T } {
  const w: { settled: boolean; value?: T } = { settled: false };
  void p.then((v) => { w.settled = true; w.value = v; });
  return w;
}
const xml = (status = 200) => new Response(status === 200 ? URLSET : 'x', { status, headers: { 'content-type': 'application/xml' } });

afterEach(() => vi.unstubAllGlobals());

describe('transport', () => {
  it('fetchTextStream uses the given transport', async () => {
    const transport = stub(xml, { finalUrl: 'https://example.com/final.xml', redirected: true });
    const r = await fetchTextStream('https://example.com/a.xml', { transport });
    expect(r.finalUrl).toBe('https://example.com/final.xml');
    expect(r.redirected).toBe(true);
    expect(r.ok).toBe(true);
    await r.stream?.cancel();
  });

  it('an empty finalUrl falls back to the requested URL', async () => {
    const transport = stub(xml, { finalUrl: '' });
    const r = await fetchTextStream('https://example.com/a.xml', { transport });
    expect(r.finalUrl).toBe('https://example.com/a.xml');
    await r.stream?.cancel();
    const failed = await fetchTextStream('https://example.com/b.xml', { transport: stub(() => xml(503), { finalUrl: '' }) });
    expect(failed.finalUrl).toBe('https://example.com/b.xml');
  });

  it('a finalUrl that is not an absolute http(s) URL falls back to the requested URL', async () => {
    for (const finalUrl of ['final.xml', '/final.xml', 'javascript:alert(1)', 'https://', 'not a url']) {
      const r = await fetchTextStream('https://example.com/a.xml', { transport: stub(xml, { finalUrl }) });
      expect(r.finalUrl, finalUrl).toBe('https://example.com/a.xml');
      await r.stream?.cancel();
    }
  });

  it('probe range reaches the transport', async () => {
    const transport = stub(xml);
    const r = await fetchTextStream('https://example.com/a.xml', { transport, probe: { range: 'bytes=0-2047' } });
    expect(new Headers(transport.mock.calls[0]?.[1].headers).get('range')).toBe('bytes=0-2047');
    await r.stream?.cancel();
  });

  it('default transport keeps network-only semantics', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchSpy);
    const r = await defaultTransport('https://example.com/a.xml', {});
    expect(fetchSpy).toHaveBeenCalledWith('https://example.com/a.xml', expect.objectContaining({ credentials: 'omit', cache: 'no-store', redirect: 'follow' }));
    expect(r.finalUrl).toBe('https://example.com/a.xml');
    expect(r.redirected).toBe(false);
  });

  it('throwing transport is a network error', async () => {
    const r = await sniffSitemap('https://example.com/a.xml', { transport: () => Promise.reject(new TypeError('x')) });
    expect(r.sniff).toBe('network-error');
  });

  it('non-2xx transport is an http error', async () => {
    const r = await sniffSitemap('https://example.com/a.xml', { transport: stub(() => xml(503)) });
    expect(r.sniff).toBe('http-error');
    expect(r.status).toBe(503);
  });

  it('discovery and robots pass the transport through', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const transport = stub(() => new Response('', { status: 404 }));
    await fetchRobots('https://example.com', { transport });
    const afterRobots = transport.mock.calls.length;
    expect(afterRobots).toBe(1);
    await discoverSitemaps('https://example.com', null, undefined, { transport });
    expect(transport.mock.calls.length).toBe(afterRobots + new Set(COMMON_PATHS).size);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gzip sniff reads the trailer through the transport and never touches global fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    const doc = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
      + Array.from({ length: 3000 }, (_, i) => `<url><loc>https://example.com/${(i * 7919).toString(36)}-${(i * 104729).toString(36)}</loc></url>`).join('') + '</urlset>';
    const gz = new Uint8Array(gzipSync(doc));
    expect(gz.length).toBeGreaterThan(2048);
    const transport = vi.fn<Transport>(async (url, init) => {
      const range = new Headers(init.headers).get('range');
      const res = range === 'bytes=-4'
        ? new Response(gz.slice(-4), { status: 206, headers: { 'content-range': `bytes ${gz.length - 4}-${gz.length - 1}/${gz.length}` } })
        : new Response(gz.slice(0, 2048), { status: 206, headers: { 'content-range': `bytes 0-2047/${gz.length}` } });
      return { res, finalUrl: url, redirected: false };
    });
    const r = await sniffSitemap('https://example.com/sitemap.xml.gz', { transport });
    expect(r).toMatchObject({ sniff: 'urlset', gzip: true, size: new TextEncoder().encode(doc).length });
    expect(r.sizeCompressed).toBeUndefined();
    const ranges = transport.mock.calls.map(([, init]) => new Headers(init.headers).get('range'));
    expect(ranges).toContain('bytes=-4');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetchRobots parses every Sitemap line from a stub transport', async () => {
    const fetchSpy = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    const body = 'User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap-a.xml\nSitemap: https://example.com/sitemap-b.xml\n';
    const transport = stub(() => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const robots = await fetchRobots('https://example.com', { transport });
    expect(robots?.found).toBe(true);
    expect(robots?.sitemapUrls).toEqual(['https://example.com/sitemap-a.xml', 'https://example.com/sitemap-b.xml']);
    expect(new URL(transport.mock.calls[0]![0]).pathname).toBe('/robots.txt');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the plain GET after a 416 or an unusable 206 through the same transport, with the caller\'s signal and no Range', async () => {
    const unusable206 = () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 100-2047/9000' } });
    for (const first of [() => new Response(null, { status: 416 }), unusable206]) {
      const fetchSpy = vi.fn(async () => new Response('', { status: 500 }));
      vi.stubGlobal('fetch', fetchSpy);
      const outer = new AbortController();
      const reason = new DOMException('superseded', 'AbortError');
      const signals: AbortSignal[] = [];
      const ranges: (string | null)[] = [];
      const transport = vi.fn<Transport>((url, init) => {
        signals.push(init.signal!);
        ranges.push(new Headers(init.headers).get('range'));
        if (ranges.length === 1) return Promise.resolve({ res: first(), finalUrl: url, redirected: false });
        return new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => { reject(init.signal!.reason as Error); }); });
      });
      const run = sniffSitemap('https://example.com/a.xml', { transport, signal: outer.signal });
      await vi.waitFor(() => { expect(transport).toHaveBeenCalledTimes(2); });
      expect(ranges).toEqual(['bytes=0-2047', null]);
      outer.abort(reason);
      expect(await run).toEqual({ sniff: 'network-error' });
      expect(signals[1]!.reason).toBe(reason);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });
});

describe('gzip trailer request', () => {
  const doc = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + Array.from({ length: 3000 }, (_, i) => `<url><loc>https://example.com/${(i * 7919).toString(36)}-${(i * 104729).toString(36)}</loc></url>`).join('') + '</urlset>';
  const gz = new Uint8Array(gzipSync(doc));
  const docBytes = new TextEncoder().encode(doc).length;
  const head = () => new Response(gz.slice(0, 2048), { status: 206, headers: { 'content-range': `bytes 0-2047/${gz.length}` } });
  const trailer = () => new Response(gz.slice(-4), { status: 206, headers: { 'content-range': `bytes ${gz.length - 4}-${gz.length - 1}/${gz.length}` } });
  const URL_GZ = 'https://example.com/sitemap.xml.gz';

  // The head answer comes first, the trailer answer second; each call records the signal it got and whether it was already aborted.
  function recording(second: (init: RequestInit) => Promise<Response> | Response, afterHead: () => void = () => undefined) {
    const signals: AbortSignal[] = [];
    const abortedAtCall: boolean[] = [];
    const transport = vi.fn<Transport>(async (url, init) => {
      signals.push(init.signal!);
      abortedAtCall.push(init.signal!.aborted);
      if (signals.length === 1) { afterHead(); return { res: head(), finalUrl: url, redirected: false }; }
      return { res: await second(init), finalUrl: url, redirected: false };
    });
    return { transport, signals, abortedAtCall };
  }
  const hangUntilAborted = (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => { reject(init.signal!.reason as Error); });
  });

  it('gets a live signal of its own, and lets go of the caller\'s signal and of its timer once answered', async () => {
    vi.useFakeTimers();
    try {
      const outer = new AbortController();
      const { transport, signals, abortedAtCall } = recording(trailer);
      const r = await sniffSitemap(URL_GZ, { transport, signal: outer.signal });
      expect(r).toMatchObject({ sniff: 'urlset', gzip: true, size: docBytes });
      expect(abortedAtCall).toEqual([false, false]);
      expect(vi.getTimerCount()).toBe(0);
      outer.abort(new Error('late'));
      expect(signals.map((s) => s.aborted)).toEqual([false, false]);
    } finally { vi.useRealTimers(); }
  });

  it('is aborted with the caller\'s own reason when the caller aborts while it is pending', async () => {
    const outer = new AbortController();
    const reason = new DOMException('superseded', 'AbortError');
    const { transport, signals } = recording(hangUntilAborted);
    const run = sniffSitemap(URL_GZ, { transport, signal: outer.signal });
    await vi.waitFor(() => { expect(transport).toHaveBeenCalledTimes(2); });
    outer.abort(reason);
    expect(await run).toMatchObject({ sniff: 'urlset', gzip: true, size: gz.length, sizeCompressed: true });
    expect(signals[1]!.reason).toBe(reason);
  });

  it('starts aborted, with the caller\'s reason, when the caller aborted during the head request', async () => {
    const outer = new AbortController();
    const reason = new DOMException('superseded', 'AbortError');
    const { transport, signals, abortedAtCall } = recording(trailer, () => { outer.abort(reason); });
    await sniffSitemap(URL_GZ, { transport, signal: outer.signal });
    expect(abortedAtCall).toEqual([false, true]);
    expect(signals[1]!.reason).toBe(reason);
  });

  it('times out after the idle limit it was given, else after 15 s, with a TimeoutError, and leaves no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const [limit, options] of [[15_000, {}], [100, { timeoutMs: 100 }]] as const) {
        const { transport, signals } = recording(hangUntilAborted);
        const run = watch(sniffSitemap(URL_GZ, { transport, ...options }));
        for (let turns = 0; transport.mock.calls.length < 2; turns++) { // the inflate of the head is real I/O
          if (turns >= 1000) throw new Error(`the trailer request was not sent within 1000 event loop turns (limit ${limit})`);
          await new Promise<void>((resolve) => { setImmediate(resolve); });
        }
        await vi.advanceTimersByTimeAsync(limit - 1);
        expect(run.settled, String(limit)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(run.value, String(limit)).toMatchObject({ sniff: 'urlset', gzip: true, size: gz.length, sizeCompressed: true });
        expect(signals[1]!.reason).toMatchObject({ name: 'TimeoutError', message: 'timeout' });
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });

  it('is not an answer unless the status is 206: four bytes in any other answer are not the trailer', async () => {
    for (const status of [200, 404, 416, 500]) {
      const { transport } = recording(() => new Response(gz.slice(-4), { status }));
      expect(await sniffSitemap(URL_GZ, { transport }), String(status)).toMatchObject({ sniff: 'urlset', gzip: true, size: gz.length, sizeCompressed: true });
    }
  });

  it('is not sent for a URL that cannot be parsed to compare origins', async () => {
    const { transport } = recording(trailer);
    const r = await sniffSitemap('not a url', { transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sniff: 'urlset', gzip: true, size: gz.length, sizeCompressed: true });
  });
});
