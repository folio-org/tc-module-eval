import { deployedVersion, isSameSiteOrigin, parseUiRuntimeOrigin, PlaywrightUiRuntimeProbe, stripesApiOrigins, uiRuntimeTargets } from '../utils/ui-runtime-probe';
import { expectLinearTime } from './helpers/linear-time';

describe('runtime UI probe rules', () => {
  it.each([
    ['https://folio-snapshot.dev.folio.org', 'https://folio-snapshot.dev.folio.org'],
    ['https://folio-snapshot.dev.folio.org/', 'https://folio-snapshot.dev.folio.org'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:9130/', 'http://127.0.0.1:9130']
  ])('accepts the origin %s', (value, origin) => {
    expect(parseUiRuntimeOrigin(value, '--ui-runtime-url')).toBe(origin);
  });

  it.each([
    ['http://folio-snapshot.dev.folio.org', 'Invalid --ui-runtime-url: use an https:// origin (http:// only for localhost).'],
    ['https://folio-snapshot.dev.folio.org/users', 'Invalid --ui-runtime-url: give an origin only, such as https://folio-snapshot.dev.folio.org, without a path, query or credentials.'],
    ['https://user:pass@folio-snapshot.dev.folio.org', 'Invalid --ui-runtime-url: give an origin only, such as https://folio-snapshot.dev.folio.org, without a path, query or credentials.'],
    ['https://folio-snapshot.dev.folio.org/?tenant=diku', 'Invalid --ui-runtime-url: give an origin only, such as https://folio-snapshot.dev.folio.org, without a path, query or credentials.'],
    ['folio-snapshot.dev.folio.org', 'Invalid --ui-runtime-url: folio-snapshot.dev.folio.org is not a URL.'],
    ['file:///etc/passwd', 'Invalid --ui-runtime-url: use an https:// origin (http:// only for localhost).']
  ])('rejects %s', (value, message) => {
    expect(() => parseUiRuntimeOrigin(value, '--ui-runtime-url')).toThrow(message);
  });

  it('builds the probe only from valid origins', () => {
    expect(() => new PlaywrightUiRuntimeProbe({ url: 'https://ui.example.org', loginOrigin: 'https://login.example.org/realms' }))
      .toThrow('Invalid --ui-runtime-login-origin');
  });

  it.each([
    ['https://folio-etesting-snapshot-kong.ci.folio.org', true],
    ['https://folio-etesting-snapshot-diku.ci.folio.org', true],
    ['http://folio-etesting-snapshot-kong.ci.folio.org', false],
    ['https://kong.folio.org', false],
    ['https://evil.ci.folio.org.example.com', false],
    ['https://ci.folio.org', false]
  ])('treats %s as on the UI site: %s', (candidate, sameSite) => {
    expect(isSameSiteOrigin('https://folio-etesting-snapshot-diku.ci.folio.org', candidate)).toBe(sameSite);
  });

  it('does not treat two-label hosts that share a top-level domain as one site', () => {
    expect(isSameSiteOrigin('https://folio.org', 'https://evil.org')).toBe(false);
    expect(isSameSiteOrigin('http://127.0.0.1:3000', 'http://127.0.0.1:9130')).toBe(true);
    expect(isSameSiteOrigin('http://127.0.0.1:3000', 'http://localhost:9130')).toBe(false);
    expect(isSameSiteOrigin('http://127.0.0.1:3000', 'http://10.0.0.1:9130')).toBe(false);
    expect(isSameSiteOrigin('https://10.1.2.3', 'https://99.1.2.3')).toBe(false);
  });

  it('visits only plain routes from package.json, their settings page and the about page', () => {
    expect(uiRuntimeTargets(JSON.stringify({ name: '@folio/users', version: '13.1.0', stripes: { route: '/users', home: '/users?sort=name' } }))).toEqual({
      targets: [{ path: '/users', source: 'route' }, { path: '/settings/users', source: 'settings' }, { path: '/settings/about', source: 'about' }],
      skipped: [{ path: '/users?sort=name', source: 'home', reason: 'not a plain path such as /users' }],
      moduleId: 'folio_users',
      packageVersion: '13.1.0'
    });
    expect(uiRuntimeTargets(JSON.stringify({ name: '@folio/x', stripes: { route: '/../admin', home: 'https://evil.example.org' } }))).toEqual({
      targets: [],
      skipped: [
        { path: '/../admin', source: 'route', reason: 'not a plain path such as /users' },
        { path: 'https://evil.example.org', source: 'home', reason: 'not a plain path such as /users' }
      ],
      moduleId: 'folio_x'
    });
    expect(uiRuntimeTargets(JSON.stringify({ name: '@folio/x', stripes: { route: '/x', home: '/home' } })).targets.map(target => target.path))
      .toEqual(['/x', '/home', '/settings/x', '/settings/about']);
    expect(uiRuntimeTargets(JSON.stringify({ name: '@folio/x', stripes: { route: '/x/y' } })).targets).toEqual([]);
    expect(uiRuntimeTargets(JSON.stringify({ name: 'stripes-x', stripes: { route: ['/x'] } }))).toEqual({ targets: [], skipped: [] });
    expect(uiRuntimeTargets('not json')).toEqual({ targets: [], skipped: [] });
  });

  it('reads the API origin only from the serialized stripes-config okapi object', () => {
    const bundle = [
      'const { okapi: { url } } = props;',
      'function f({ okapi: { url: host } }) {}',
      '"okapi": { "tenant": "diku" }, "config": { "url": "https://not-okapi.example.org" }',
      '"okapi": {\n    "url": "https://folio-etesting-snapshot-kong.ci.folio.org",\n    "uiUrl": "https://folio-etesting-snapshot-diku.ci.folio.org"\n  }'
    ].join('\n');
    expect(stripesApiOrigins(bundle)).toEqual(['https://folio-etesting-snapshot-kong.ci.folio.org']);
    expect(stripesApiOrigins('"okapi": {"tenant": "a", "url": "https://a.example.org/path"} "okapi": {"url": "https://b.example.org"}'))
      .toEqual(['https://a.example.org', 'https://b.example.org']);
    expect(stripesApiOrigins('"okapi": {"url": "not a url"}')).toEqual([]);
  });

  it('reads the deployed version of the module itself from the about page', () => {
    const about = 'Users\nfolio_users-keycloak-1.0.0\nxfolio_users-9.9.9\nfolio_users-13.1.1099000000001651\nmod-users-19.7.0-SNAPSHOT.2170';
    expect(deployedVersion(about, 'folio_users')).toBe('13.1.1099000000001651');
    expect(deployedVersion('folio_checkin-', 'folio_checkin')).toBeUndefined();
  });

  it('scans bundles and about pages in linear time', async () => {
    await expectLinearTime(50_000, size => `${'"okapi" : { "uri" '.repeat(size)}${'"okapi":{'.repeat(size)}"okapi": {${' '.repeat(size)}`,
      async text => stripesApiOrigins(text));
    await expectLinearTime(8_000, size => `${'folio_users-x '.repeat(size)}${'afolio_users-1'.repeat(size)}`,
      async text => deployedVersion(text, 'folio_users'));
  });
});
