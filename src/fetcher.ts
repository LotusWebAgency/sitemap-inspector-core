export interface FetchMeta { status: number; finalUrl: string; redirected: boolean; lastModified?: string | undefined; contentType?: string | undefined; gzip: boolean }
/** The response headers a size check needs; present only when the caller asked for them (FetchOptions.probe). */
interface SizeHeaders { contentRange: string | null; contentLength: string | null; contentEncoding: string | null }
export interface TextStreamResult extends FetchMeta { ok: boolean; stream: ReadableStream<string> | null; sizeHeaders?: SizeHeaders }
export type SniffKind = 'urlset' | 'sitemapindex' | 'not-sitemap' | 'http-error' | 'network-error' | 'not-utf8';
export interface SniffResult extends Partial<FetchMeta> {
  sniff: SniffKind;
  encoding?: string | undefined; // set with 'not-utf8'
  /** File size in bytes: the file as served, and for a .gz its uncompressed size (gzip trailer); the compressed one only with `sizeCompressed`. null = answered, size unknown; absent when the sniff got no answer. */
  size?: number | null;
  /** The size is the compressed one of a .gz file (its gzip trailer could not be read). */
  sizeCompressed?: true;
}

// The body is UTF-16 or UTF-32 (a byte order mark at its start): the decoder would turn it into NULs, so the read fails instead.
export class NotUtf8Error extends Error {
  constructor(readonly encoding: 'UTF-16' | 'UTF-32') { super(`not UTF-8 (${encoding})`); this.name = 'NotUtf8Error'; }
}

function bomEncoding(b: Uint8Array): 'UTF-16' | 'UTF-32' | null {
  if (b[0] === 0xff && b[1] === 0xfe) return b.length >= 4 && b[2] === 0 && b[3] === 0 ? 'UTF-32' : 'UTF-16';
  if (b[0] === 0xfe && b[1] === 0xff) return 'UTF-16';
  if (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) return 'UTF-32';
  return null;
}

// Looks at the first bytes of the (decompressed) body and errors the stream on a UTF-16 / UTF-32 byte order mark, before the rest is read.
function bomGuard(): TransformStream<Uint8Array, Uint8Array> {
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let checked = false;
  const release = (c: TransformStreamDefaultController<Uint8Array>): void => {
    checked = true;
    const head = new Uint8Array(Math.min(heldBytes, 4));
    let off = 0;
    for (const chunk of held) { const take = Math.min(chunk.length, head.length - off); head.set(chunk.subarray(0, take), off); off += take; if (off >= head.length) break; }
    const encoding = bomEncoding(head);
    if (encoding) throw new NotUtf8Error(encoding);
    for (const chunk of held) c.enqueue(chunk);
    held.length = 0;
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      if (checked) { c.enqueue(chunk); return; }
      held.push(chunk); heldBytes += chunk.length;
      if (heldBytes >= 4) release(c);
    },
    flush(c) { if (!checked) release(c); },
  });
}

async function peekBytes(stream: ReadableStream<Uint8Array>, n: number): Promise<[Uint8Array, ReadableStream<Uint8Array>]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
  }
  const head = new Uint8Array(Math.min(got, n));
  let off = 0;
  for (const c of chunks) { const take = Math.min(c.length, n - off); head.set(c.subarray(0, take), off); off += take; if (off >= n) break; }
  const rest = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(ch); },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return [head, rest];
}

export interface FetchOptions {
  /** Longest wait for the response headers, and then for the next piece of the body (an idle timeout, not a limit on the whole download). */
  timeoutMs?: number;
  /** Longest the whole fetch may take, headers and body together (default 120 s): a server that drips bytes keeps the idle timeout from ever firing. */
  totalMs?: number;
  /** Aborts the request and the body read, e.g. when the scan is superseded. */
  signal?: AbortSignal | undefined;
  /** A size check: the result carries the headers that tell the file size, and `range` (e.g. "bytes=0-2047") is sent as the Range header. */
  probe?: { range?: string };
  /** How requests reach the network (default: `defaultTransport`, a direct fetch). A web build can route them through a proxy. */
  transport?: Transport | undefined;
}

/** `finalUrl` and `redirected` travel beside the Response because a proxied Response cannot carry them. */
export interface TransportResponse { res: Response; finalUrl: string; redirected: boolean }
export type Transport = (url: string, init: RequestInit) => Promise<TransportResponse>;

// Every request goes to the server and nothing is kept: the HTTP cache would serve a re-scan the copy it read before (up to max-age, and
// a cached copy may differ from what the page itself saw), and browsers answer a Range from a cached compressed body with ranges of the encoded bytes.
const NETWORK_ONLY = { credentials: 'omit', redirect: 'follow', cache: 'no-store' } as const satisfies RequestInit;

export const defaultTransport: Transport = async (url, init) => {
  const res = await globalThis.fetch(url, { ...NETWORK_ONLY, ...init });
  return { res, finalUrl: res.url || url, redirected: res.redirected };
};

export async function fetchTextStream(url: string, opts: FetchOptions = {}): Promise<TextStreamResult> {
  const limitMs = opts.timeoutMs ?? 30_000;
  const totalMs = opts.totalMs ?? 120_000;
  const ctrl = new AbortController();
  const outer = opts.signal;
  const onOuterAbort = () => { ctrl.abort(outer?.reason); };
  if (outer?.aborted === true) onOuterAbort(); else outer?.addEventListener('abort', onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => { clearTimeout(timer); timer = undefined; };
  const arm = () => { disarm(); timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), limitMs); };
  // The second timer: never restarted, so it ends the fetch however the bytes trickle in. release() clears both on every way out.
  let totalTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), totalMs);
  const release = () => { disarm(); clearTimeout(totalTimer); totalTimer = undefined; outer?.removeEventListener('abort', onOuterAbort); };
  arm();
  let res: Response;
  let finalUrl: string;
  let redirected: boolean;
  const range = opts.probe?.range;
  try { ({ res, finalUrl, redirected } = await (opts.transport ?? defaultTransport)(url, { signal: ctrl.signal, ...(range === undefined ? {} : { headers: { Range: range } }) })); }
  catch (e) { release(); throw e; }
  const meta = {
    status: res.status, finalUrl, redirected,
    lastModified: res.headers.get('last-modified') ?? undefined,
    contentType: res.headers.get('content-type') ?? undefined,
    ...(opts.probe ? { sizeHeaders: { contentRange: res.headers.get('content-range'), contentLength: res.headers.get('content-length'), contentEncoding: res.headers.get('content-encoding') } } : {}),
  };
  if (!res.ok || !res.body) {
    release();
    void res.body?.cancel().catch(() => { /* releasing the connection anyway; the reason doesn't matter */ });
    return { ok: false, ...meta, gzip: false, stream: null };
  }
  let head: Uint8Array; let rest: ReadableStream<Uint8Array>;
  try { [head, rest] = await peekBytes(res.body, 2); }
  catch (e) { release(); throw e; }
  disarm(); // from here the timer only runs while a read waits for the network
  const gzip = head.length === 2 && head[0] === 0x1f && head[1] === 0x8b;
  let bytes: ReadableStream<Uint8Array> = rest;
  // lib.dom's BufferSource-typed WritableStream on these transforms doesn't line up with
  // ReadableStream<Uint8Array> under strict variance checking; the shape is correct at runtime.
  if (gzip) bytes = bytes.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  bytes = bytes.pipeThrough(bomGuard());
  const text: ReadableStream<string> = bytes.pipeThrough(new TextDecoderStream('utf-8') as unknown as ReadableWritablePair<string, Uint8Array>);
  // release on drain (flush); cancellation propagates bidirectionally through pipeThrough
  const clearTimer = release;
  const cleared: ReadableStream<string> = text.pipeThrough(new TransformStream<string, string>({ flush: clearTimer }));
  // wrap to intercept and propagate cancel while clearing timer
  let reader: ReadableStreamDefaultReader<string> | null = null;
  let cancelled = false;
  return { ok: true, ...meta, gzip, stream: new ReadableStream<string>({
    start() { reader = cleared.getReader(); },
    async pull(c) {
      if (!reader) return; // start() always runs before pull() per the ReadableStream spec
      arm(); // idle timeout: counts only the wait for the network, not the consumer's own work between reads
      try {
        const { done, value } = await reader.read();
        if (cancelled) { release(); return; } // the read a cancel() resolved: the wrapper is closed already
        if (done) { c.close(); } else { c.enqueue(value); }
      } catch (e) { release(); if (!cancelled) throw e; }
      disarm();
    },
    async cancel(reason) {
      clearTimer();
      cancelled = true;
      // through the reader that holds the lock: releaseLock can throw while pull's read is pending, and a pending read resolves as done
      const held = reader;
      reader = null;
      try { await held?.cancel(reason); } catch { /* ignore */ }
    },
  }) };
}

// A plain-text sitemap (sitemaps.org "Text" format): no markup, and the first non-empty line is one absolute http(s) URL.
const TEXT_SITEMAP_LINE = /^https?:\/\/\S+$/i;

// Index just past the '>' that closes the DOCTYPE starting at s[0]: the one outside quotes and outside [ ... ], with comments and
// processing instructions in the internal subset skipped whole (the same rule as the tokenizer's skipDoctype); -1 when the head ends first.
function doctypeEnd(s: string): number {
  let quote = '';
  let sub = false;
  for (let i = 9; i < s.length; i++) {
    const c = s.charAt(i);
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (sub) {
      const close = s.startsWith('<!--', i) ? '-->' : s.startsWith('<?', i) ? '?>' : '';
      if (close) { const e = s.indexOf(close, close === '?>' ? i + 1 : i + 2); if (e === -1) return -1; i = e + close.length - 1; continue; } // `<?>` closes at once, like the tokenizer
      if (c === ']') sub = false;
    } else if (c === '[') sub = true;
    else if (c === '>') return i + 1;
  }
  return -1;
}

type HeadVerdict = 'urlset' | 'sitemapindex' | 'not-sitemap';

// 'cut': the head ran out before a verdict was possible (inside a comment, processing instruction, declaration or the root name, or nothing but a prolog).
function walkHead(head: string): HeadVerdict | 'cut' {
  let s = head.replace(/^\uFEFF/, '').trimStart();
  if (!s.startsWith('<')) return s === '' ? 'cut' : TEXT_SITEMAP_LINE.test((s.split(/\r\n|\r|\n/, 1)[0] ?? '').trim()) ? 'urlset' : 'not-sitemap';
  for (;;) {
    if (s.startsWith('<?')) { const e = s.indexOf('?>'); if (e === -1) return 'cut'; s = s.slice(e + 2).trimStart(); continue; }
    if (s.startsWith('<!--')) { const e = s.indexOf('-->'); if (e === -1) return 'cut'; s = s.slice(e + 3).trimStart(); continue; }
    if (s.startsWith('<!DOCTYPE')) { const e = doctypeEnd(s); if (e === -1) return 'cut'; s = s.slice(e).trimStart(); continue; }
    if (s.startsWith('<!')) { const e = s.indexOf('>'); if (e === -1) return 'cut'; s = s.slice(e + 1).trimStart(); continue; }
    break;
  }
  if (s === '' || s === '<') return 'cut';
  const m = /^<([\w:.-]+)/.exec(s);
  if (!m?.[1]) return 'not-sitemap';
  if (m[0].length === s.length) return 'cut';
  const name = m[1].slice(m[1].lastIndexOf(':') + 1).toLowerCase();
  return name === 'urlset' ? 'urlset' : name === 'sitemapindex' ? 'sitemapindex' : 'not-sitemap';
}

export function classifyHead(head: string): HeadVerdict {
  const verdict = walkHead(head);
  return verdict === 'cut' ? 'not-sitemap' : verdict;
}

/** classifyHead for a head that may be only the start of the file: when `complete` is false, a head that ran out early is 'unknown', not 'not-sitemap'. */
function classifyHeadPartial(head: string, complete: boolean): HeadVerdict | 'unknown' {
  const verdict = walkHead(head);
  return verdict === 'cut' ? (complete ? 'not-sitemap' : 'unknown') : verdict;
}

const HEAD_BYTES = 2048; // the ranged request
const HEAD_CHARS = 2048; // what the head read stops at, whichever request it comes from
const HEAD_RANGE = `bytes=0-${HEAD_BYTES - 1}`;
// A size above this is a lie or a bug (a sitemap is at most 50 MB): it is stored and summed, so it is dropped.
const MAX_SIZE = 2 ** 40;

const digits = (s: string): number | null => {
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_SIZE ? n : null;
};

/** "bytes a-b/N" → { start: a, end: b, total: N }; total is null for "/*" or a size past MAX_SIZE. Anything else → null. */
function parseContentRange(header: string | null): { start: number; end: number; total: number | null } | null {
  const m = /^bytes\s+(\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/i.exec(header?.trim() ?? '');
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : digits(m[3]) };
}

// A 206 answers the request only when it starts at byte 0 and stays inside the range that was asked for.
function rangeFits(r: TextStreamResult): boolean {
  const cr = parseContentRange(r.sizeHeaders?.contentRange ?? null);
  return cr !== null && cr.start === 0 && cr.end <= HEAD_BYTES - 1;
}

// The size a response says it has. A 206 names the whole file in Content-Range. A plain 200 sends the file itself: its Content-Length is the file's size.
// Neither holds when a Content-Encoding changed the bytes on the wire: both then count the encoded ones.
function servedSize(r: TextStreamResult): number | null {
  const h = r.sizeHeaders;
  if (!h) return null;
  const encoding = h.contentEncoding?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return null;
  if (r.status === 206) return rangeFits(r) ? (parseContentRange(h.contentRange)?.total ?? null) : null;
  return h.contentLength !== null ? digits(h.contentLength.trim()) : null;
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// The last four bytes of a gzip file are its uncompressed size (mod 2^32), little-endian. null unless the server answers the range with exactly those bytes.
async function gzipTrailerSize(url: string, opts: FetchOptions): Promise<number | null> {
  const ctrl = new AbortController();
  const outer = opts.signal;
  const onOuterAbort = () => { ctrl.abort(outer?.reason); };
  if (outer?.aborted === true) onOuterAbort(); else outer?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), opts.timeoutMs ?? 15_000);
  try {
    const { res } = await (opts.transport ?? defaultTransport)(url, { signal: ctrl.signal, headers: { Range: 'bytes=-4' } });
    if (res.status !== 206 || !res.body) { void res.body?.cancel().catch(() => { /* the answer is not usable; releasing the connection */ }); return null; }
    const [tail, rest] = await peekBytes(res.body, 5);
    void rest.cancel().catch(() => { /* more than four bytes: not what was asked for */ });
    return tail.length === 4 ? new DataView(tail.buffer, tail.byteOffset, 4).getUint32(0, true) : null;
  } catch { return null; }
  finally { clearTimeout(timer); outer?.removeEventListener('abort', onOuterAbort); }
}

interface Opened { r: TextStreamResult; head: string; ended: boolean; emptyAnswer: boolean }

// One GET, ranged when `range` is given, read until the head holds HEAD_CHARS characters or the body ends. A 416 (an empty file answers it) and a 206 that is not the
// head that was asked for (it does not start at 0 or runs past the range) are answered with one plain GET instead.
async function openHead(url: string, opts: FetchOptions, range: string | undefined): Promise<Opened | SniffResult> {
  let r: TextStreamResult;
  let refused = false;
  try {
    r = await fetchTextStream(url, { ...opts, probe: range === undefined ? {} : { range } });
    if (range !== undefined && (r.status === 416 || (r.status === 206 && !rangeFits(r)))) {
      refused = r.status === 416;
      void r.stream?.cancel().catch(() => { /* the answer is not the head; releasing the connection */ });
      r = await fetchTextStream(url, { ...opts, probe: {} });
    }
  } catch { return { sniff: 'network-error' }; }
  if (!r.ok || !r.stream) {
    return { sniff: 'http-error', status: r.status, finalUrl: r.finalUrl, redirected: r.redirected, gzip: false, lastModified: r.lastModified, contentType: r.contentType };
  }
  const reader = r.stream.getReader();
  let head = '';
  let ended = false;
  try {
    while (head.length < HEAD_CHARS) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      head += value;
    }
  } catch (e) {
    // a ranged gzip head is a cut-off stream: it ends in an error once what was inflated has been read, and that text is the head
    if (!(r.gzip && r.status === 206 && head.length > 0 && !(e instanceof NotUtf8Error))) {
      void reader.cancel().catch(() => { /* best-effort; the stream already failed */ });
      return e instanceof NotUtf8Error ? { sniff: 'not-utf8', encoding: e.encoding } : { sniff: 'network-error' };
    }
  }
  void reader.cancel().catch(() => { /* best-effort; the stream is already abandoned */ });
  return { r, head, ended, emptyAnswer: refused && ended && head === '' };
}

/**
 * Says what a sitemap is and how big it is. Ranged GET of the first 2,048 bytes; a plain GET fallback is read until 2,048 characters. The rest is never downloaded.
 * A head the range cut inside a long prolog (a comment, a processing instruction, a DOCTYPE) is read again with one plain GET until 2,048 characters, as
 * discovery always did. A check is at most three requests: the ranged one, that second read (or the plain GET a 416 / unusable 206 gets), and for a .gz the trailer.
 * A 206 is reported as 200: the file exists and answers.
 */
export async function sniffSitemap(url: string, opts: FetchOptions = {}): Promise<SniffResult> {
  const fetchOpts: FetchOptions = { timeoutMs: opts.timeoutMs ?? 15_000, totalMs: opts.totalMs ?? 30_000, signal: opts.signal, transport: opts.transport };
  const first = await openHead(url, fetchOpts, HEAD_RANGE);
  if ('sniff' in first) return first;
  const { r, head, ended, emptyAnswer } = first;
  const { status, finalUrl, redirected, lastModified, contentType, gzip } = r;
  let size = servedSize(r);
  // the whole file is in the head: a 206 whose total fits the range, or a body that ended
  const complete = ended && (status !== 206 || (size !== null && size <= HEAD_BYTES));
  let verdict = classifyHeadPartial(head, complete);
  if (verdict === 'unknown') {
    if (status === 206) {
      const more = await openHead(url, fetchOpts, undefined);
      if ('sniff' in more) return more;
      verdict = classifyHead(more.head);
      size ??= servedSize(more.r);
    } else {
      verdict = classifyHead(head); // a plain body that went on past the head: what a plain GET always made of it
    }
  }
  if (size === null && emptyAnswer) size = 0;
  let sizeCompressed = false;
  if (gzip) {
    // `size` so far is the compressed one: the trailer has the real one, and without it the compressed size is all there is
    const uncompressed = sameOrigin(url, finalUrl) ? await gzipTrailerSize(finalUrl, fetchOpts) : null; // a redirect to another origin gets no request of its own
    if (uncompressed !== null) size = uncompressed; else if (size !== null) sizeCompressed = true;
  }
  return {
    sniff: verdict, status: status === 206 ? 200 : status, finalUrl, redirected, lastModified, contentType, gzip, size, ...(sizeCompressed ? { sizeCompressed: true as const } : {}),
  };
}

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const MAX_MEDIA_TYPE_CHARS = 100;

/** "Text/XML; charset=UTF-8" → "text/xml". The header is untrusted and stored, so anything that isn't a short media type is dropped. */
export function mediaType(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const semi = header.indexOf(';');
  const v = (semi === -1 ? header : header.slice(0, semi)).trim().toLowerCase();
  return v.length <= MAX_MEDIA_TYPE_CHARS && MEDIA_TYPE.test(v) ? v : undefined;
}
