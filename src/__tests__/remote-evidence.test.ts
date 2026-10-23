import { isAllowedRemoteUrl, RemoteEvidenceTransport } from '../utils/remote-evidence';

const FAR = 'https://far.ci.folio.org/applications?query=id%3D%3Dapp-a-1.0.0';
const SONAR = 'https://sonarcloud.io/api/components/show?component=org.folio:mod-x';
const GITHUB = 'https://api.github.com/repos/folio-org/platform-lsp/commits?sha=snapshot';
const RAW = 'https://raw.githubusercontent.com/folio-org/platform-lsp/abc/platform-descriptor.json';

interface Call { url: string; authorization?: string }

function transport(
  handler: (url: string, call: number) => Response | Promise<Response>,
  options: ConstructorParameters<typeof RemoteEvidenceTransport>[0] = {}
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    return handler(url, calls.length);
  }) as typeof fetch;
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    remote: new RemoteEvidenceTransport({ fetchImpl, sleep: async ms => { sleeps.push(ms); }, ...options })
  };
}

const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, ...init });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

describe('remote evidence transport', () => {
  it.each([
    ['https://far.ci.folio.org/applications?query=x', true],
    ['https://sonarcloud.io/api/measures/component', true],
    ['https://raw.githubusercontent.com/folio-org/platform-lsp/abc/platform-descriptor.json', true],
    ['https://raw.githubusercontent.com/folio-org/app-search/HEAD/app-search.template.json', true],
    ['https://api.github.com/repos/folio-org/platform-lsp/commits', true],
    ['http://far.ci.folio.org/applications', false],
    ['https://far.ci.folio.org:8443/applications', false],
    ['https://user:pw@far.ci.folio.org/applications', false],
    ['https://far.ci.folio.org/modules', false],
    ['https://far.ci.folio.org.evil.example/applications', false],
    ['https://raw.githubusercontent.com/folio-org/mod-search/HEAD/pom.xml', false],
    ['https://raw.githubusercontent.com/someone/platform-lsp/HEAD/platform-descriptor.json', false],
    ['https://raw.githubusercontent.com/folio-org/app-x%2F..%2F..%2Fother/HEAD/x', false],
    ['https://api.github.com/repos/folio-org/platform-lsp-fork/commits', false],
    ['https://api.github.com/user', false],
    ['https://sonarcloud.io/account', false]
  ])('allows %s: %s', (url, allowed) => {
    expect(isAllowedRemoteUrl(new URL(url))).toBe(allowed);
  });

  it('returns parsed JSON and records the URL, status, size and digest of every read', async () => {
    const { remote } = transport(url => url === FAR ? json({ a: 1 }) : new Response('nope', { status: 404 }));

    const ok = await remote.getJson(FAR);
    const missing = await remote.getJson(RAW);
    const refused = await remote.getJson('https://example.org/x.json');

    expect(ok).toMatchObject({ ok: true, json: { a: 1 } });
    expect(remote.records).toEqual([
      { url: FAR, fetchedAt: expect.any(String), status: 200, bytes: 7, sha256: 'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862' },
      { url: RAW, fetchedAt: expect.any(String), status: 404, error: 'HTTP 404.' },
      { url: 'https://example.org/x.json', fetchedAt: expect.any(String), error: 'Requested a host or path the tool may not read: https://example.org/x.json' }
    ]);
    expect(missing).toMatchObject({ ok: false, reason: 'http-status', status: 404 });
    expect(refused).toMatchObject({ ok: false, reason: 'not-allowed' });
  });

  it('refuses a redirect off the allowlist without requesting it', async () => {
    const { remote, calls } = transport(() => redirect('https://evil.example/applications'));

    expect(await remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'not-allowed' });
    expect(calls.map(call => call.url)).toEqual([FAR]);
  });

  it('sends each token only to its own host, so a redirect to another allowed host drops it', async () => {
    const { remote, calls } = transport(url => url.startsWith('https://sonarcloud.io/') ? redirect(GITHUB, 307)
      : url.startsWith(GITHUB) ? redirect(RAW) : json({}), { credentials: { sonarToken: 'sonar-secret', githubToken: 'github-secret' } });

    const result = await remote.getJson(SONAR);
    await remote.getJson(FAR);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { url: SONAR, authorization: 'Bearer sonar-secret' },
      { url: GITHUB, authorization: 'Bearer github-secret' },
      { url: RAW, authorization: undefined },
      { url: FAR, authorization: undefined }
    ]);
    expect(remote.records[0]).toMatchObject({
      url: SONAR, finalUrl: RAW, status: 200,
      attempts: [{ url: SONAR, status: 307 }, { url: GITHUB, status: 302 }, { url: RAW, status: 200 }]
    });
    expect(JSON.stringify(remote.records)).not.toMatch(/secret/);
  });

  it('does not send, record or report a token that is not a valid header value', async () => {
    const { remote, calls } = transport(() => json({}), { credentials: { githubToken: 'token-part-one\ntoken-part-two' } });

    const result = await remote.getJson(GITHUB);
    await remote.getJson(FAR);

    expect(result).toMatchObject({ ok: false, reason: 'invalid-credentials', record: { error: 'GITHUB_TOKEN is not a valid token, so the request was not sent.' } });
    expect(calls.map(call => call.url)).toEqual([FAR]);
    expect(JSON.stringify(remote.records)).not.toMatch(/token-part/);
  });

  it('keeps fetch error text, which can quote request headers, out of the record', async () => {
    const { remote } = transport(() => {
      throw Object.assign(new TypeError('Headers.append: "Bearer github-secret" is an invalid header value.'), { cause: { code: 'UND_ERR_INVALID_ARG' } });
    }, { credentials: { githubToken: 'github-secret' } });

    const result = await remote.getJson(GITHUB);

    expect(result).toMatchObject({ ok: false, reason: 'network', record: { error: 'The request failed (UND_ERR_INVALID_ARG).' } });
    expect(JSON.stringify(remote.records)).not.toMatch(/secret/);
  });

  it('follows at most 3 redirects', async () => {
    const follow = (hops: number) => transport((_url, call) => call <= hops ? redirect(`${FAR}&hop=${call}`) : json({ hops }));

    const three = follow(3);
    expect(await three.remote.getJson(FAR)).toMatchObject({ ok: true, json: { hops: 3 } });
    const four = follow(4);
    expect(await four.remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'redirect-limit' });
    expect(four.calls).toHaveLength(4);
  });

  it('rejects a response over 4 MiB whether or not it declares its length', async () => {
    const big = 4 * 1024 * 1024 + 1;
    const declared = transport(() => new Response('{}', { headers: { 'content-length': String(big) } }));
    const streamed = transport(() => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); }
    })));

    expect(await declared.remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await streamed.remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'too-large', record: { error: 'The response is larger than 4 MiB.' } });
    const exactly = transport(() => new Response(`"${' '.repeat(4 * 1024 * 1024 - 2)}"`));
    expect(await exactly.remote.getJson(FAR)).toMatchObject({ ok: true });
  });

  it('reports invalid JSON as a failure, not as an empty value', async () => {
    const { remote } = transport(() => new Response('<html>rate limited</html>'));
    expect(await remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'invalid-json' });
  });

  it('retries once after a short Retry-After, but does not wait for a long one', async () => {
    const short = transport((_url, call) => call === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : json({ ok: true }));
    expect(await short.remote.getJson(FAR)).toMatchObject({ ok: true });
    expect(short.sleeps).toEqual([3000]);

    const long = transport(() => new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
    expect(await long.remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'rate-limited', status: 429 });
    expect(long.sleeps).toEqual([]);
    expect(long.calls).toHaveLength(1);

    const twice = transport(() => new Response('', { status: 503 }));
    expect(await twice.remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'http-status', status: 503 });
    expect(twice.calls).toHaveLength(2);
  });

  it('gives up on a request that does not answer, or stops sending its body, within the timeout', async () => {
    const never = new RemoteEvidenceTransport({
      fetchImpl: ((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch,
      limits: { requestTimeoutMs: 20 }
    });
    expect(await never.getJson(FAR)).toMatchObject({ ok: false, reason: 'timeout' });

    const stalled = new RemoteEvidenceTransport({
      fetchImpl: ((_input: string | URL, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"a":'));
          init!.signal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        }
      })))) as typeof fetch,
      limits: { requestTimeoutMs: 20 }
    });
    expect(await stalled.getJson(FAR)).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('stops after 150 requests in one evaluation, counting redirects and retries', async () => {
    const { remote, calls } = transport((_url, call) => call === 1 ? redirect(`${FAR}&b`) : json({}));
    const results = await Promise.all(Array.from({ length: 151 }, () => remote.getJson(FAR)));

    expect(calls).toHaveLength(150);
    expect(results.filter(result => result.ok)).toHaveLength(149);
    expect(results.filter(result => !result.ok).map(result => !result.ok && result.reason)).toEqual(['budget-requests', 'budget-requests']);
  });

  it('stops reading once the evaluation has received 32 MiB', async () => {
    const body = `"${' '.repeat(3 * 1024 * 1024)}"`;
    const { remote, calls } = transport(() => new Response(body));
    const results: boolean[] = [];
    for (let index = 0; index < 12; index++) results.push((await remote.getJson(FAR)).ok);

    // 10 responses of just over 3 MiB fit in 32 MiB; the 11th crosses it, and the 12th is never sent.
    expect(results).toEqual([...Array(10).fill(true), false, false]);
    expect(calls).toHaveLength(11);
    expect(remote.records.slice(-2).map(record => record.error)).toEqual([
      "The evaluation's limit of 32 MiB of remote responses was reached.",
      "The evaluation's limit of 32 MiB of remote responses was reached."
    ]);
  });

  it('stops once 120 s have passed since the first remote read, including a response that completes after it', async () => {
    let now = 1_000_000;
    const { remote, calls } = transport(() => {
      now += 11_000;
      return json({});
    }, { now: () => now });

    const results = [];
    for (let index = 0; index < 12; index++) results.push(await remote.getJson(FAR));
    // Ten reads end by 110 s; the eleventh starts with 10 s left and ends at 121 s, and the twelfth is not sent.
    expect(results.map(result => result.ok ? 'ok' : result.reason)).toEqual([...Array(10).fill('ok'), 'budget-time', 'budget-time']);
    expect(calls).toHaveLength(11);
  });

  it('rejects a response that completes after the 15 s request limit even if the timer has not fired', async () => {
    let now = 0;
    const { remote } = transport(() => new Response(new ReadableStream({
      pull(controller) {
        now += 16_000;
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      }
    })), { now: () => now });

    expect(await remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('does not wait for a retry that would run past the evaluation deadline', async () => {
    let now = 0;
    const { remote, sleeps } = transport(() => {
      now += 8_000;
      return new Response('', { status: 503, headers: { 'retry-after': '8' } });
    }, { now: () => now, limits: { maxDurationMs: 15_000 } });

    expect(await remote.getJson(FAR)).toMatchObject({ ok: false, reason: 'budget-time' });
    expect(sleeps).toEqual([]);
  });

  it('has at most 4 requests in flight', async () => {
    let active = 0;
    let peak = 0;
    const { remote } = transport(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return json({});
    });

    const results = await Promise.all(Array.from({ length: 12 }, () => remote.getJson(FAR)));
    expect(results.every(result => result.ok)).toBe(true);
    expect(peak).toBe(4);
  });
});
