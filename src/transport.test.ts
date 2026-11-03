import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultTransport, fetchTextStream, sniffSitemap, type Transport } from './fetcher.js';
import { discoverSitemaps } from './discovery.js';
import { fetchRobots } from './robots.js';

const URLSET = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>';
const stub = (res: () => Response, extra: { finalUrl?: string; redirected?: boolean } = {}) =>
  vi.fn<Transport>(async (url) => ({ res: res(), finalUrl: extra.finalUrl ?? url, redirected: extra.redirected ?? false }));
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
    expect(transport.mock.calls.length).toBeGreaterThan(afterRobots);
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
});
