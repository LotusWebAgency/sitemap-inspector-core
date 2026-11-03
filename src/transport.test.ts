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
});
