import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { BrowserContext, CDPSession, Page, Request } from 'playwright-core';
import type { Protocol } from 'playwright-core/types/protocol';
import {
  EvaluationRun,
  UiRuntimeAxeViolation,
  UiRuntimeEvidence,
  UiRuntimePage,
  UiRuntimeProbe,
  UiRuntimeRequestRecord,
  UiRuntimeSkippedPath,
  UiRuntimeTarget
} from '../types';
import type { FrontendSource } from './frontend-source';
import { redactEvaluatorSecretsInValue } from './redaction';
import { errorMessage, isRecord } from './type-guards';

export interface UiRuntimeLimits {
  maxPages: number;
  pageTimeoutMs: number;
  totalTimeoutMs: number;
  quietMs: number;
  maxQuietWaitMs: number;
  nodesPerRule: number;
  nodeHtmlChars: number;
  consolePerPage: number;
  consoleChars: number;
  failedRequestsPerPage: number;
  blockedRequests: number;
  navigations: number;
  urlChars: number;
}

export const UI_RUNTIME_LIMITS: Readonly<UiRuntimeLimits> = {
  maxPages: 6,
  pageTimeoutMs: 30_000,
  totalTimeoutMs: 180_000,
  quietMs: 1_000,
  maxQuietWaitMs: 10_000,
  nodesPerRule: 10,
  nodeHtmlChars: 300,
  consolePerPage: 50,
  consoleChars: 500,
  failedRequestsPerPage: 50,
  blockedRequests: 200,
  navigations: 100,
  urlChars: 300
};

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const PLAIN_ROUTE = /^\/[A-Za-z0-9-]+$/;
const FOLIO_PACKAGE = /^@folio\/([a-z0-9-]+)$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOGIN_WRITE_PATH = /^\/realms\/[^/]+\/(?:login-actions\/authenticate|protocol\/openid-connect\/token)$/;
const API_WRITE_PATH = /^\/authn\/(?:token|refresh)$/;
const STRIPES_OKAPI_CONFIG = /"okapi"\s*:\s*\{/g;
const STRIPES_OKAPI_URL = /"url"\s*:\s*"([^"\\\s]{1,200})"/;
const MAX_CONFIG_OBJECT_CHARS = 2_000;
const MAX_ABOUT_TEXT_CHARS = 1_000_000;
const DEPLOYED_VERSION = /^\d[0-9A-Za-z.+-]{0,63}/;
const BLOCKED_ERROR = 'net::ERR_BLOCKED_BY_CLIENT';
const NO_PRELOADING_PREFERENCES = JSON.stringify({ net: { network_prediction_options: 2 } });
const NO_WORKERS_SCRIPT = `for (const name of ['Worker', 'SharedWorker']) {
  Object.defineProperty(window, name, { configurable: false, writable: false, value: function () { throw new DOMException(name + ' is disabled', 'SecurityError'); } });
}`;

export interface UiRuntimeOptions {
  url: string;
  loginOrigin: string;
  chromePath?: string;
}

export function parseUiRuntimeOrigin(value: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${flag}: ${value} is not a URL.`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Invalid ${flag}: use an https:// origin (http:// only for localhost).`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Invalid ${flag}: give an origin only, such as https://folio-snapshot.dev.folio.org, without a path, query or credentials.`);
  }
  return url.origin;
}

export function isSameSiteOrigin(uiOrigin: string, candidate: string): boolean {
  const ui = new URL(uiOrigin);
  const other = new URL(candidate);
  if (ui.protocol !== other.protocol) return false;
  if (ui.hostname === other.hostname) return true;
  if (net.isIP(ui.hostname.replace(/^\[|\]$/g, '')) || net.isIP(other.hostname.replace(/^\[|\]$/g, ''))) return false;
  const parent = (host: string) => host.split('.').slice(1).join('.');
  return ui.hostname.split('.').length >= 3 && other.hostname.split('.').length >= 3 && parent(ui.hostname) === parent(other.hostname);
}

export interface UiRuntimeTargets {
  targets: UiRuntimeTarget[];
  skipped: UiRuntimeSkippedPath[];
  moduleId?: string;
  packageVersion?: string;
}

export function uiRuntimeTargets(packageJsonText: string | undefined): UiRuntimeTargets {
  let manifest: Record<string, unknown> | undefined;
  try {
    const value: unknown = packageJsonText ? JSON.parse(packageJsonText) : undefined;
    manifest = isRecord(value) ? value : undefined;
  } catch {
    manifest = undefined;
  }
  const stripes = isRecord(manifest?.stripes) ? manifest.stripes : undefined;
  const name = typeof manifest?.name === 'string' ? FOLIO_PACKAGE.exec(manifest.name)?.[1] : undefined;
  const result: UiRuntimeTargets = {
    targets: [],
    skipped: [],
    ...(name ? { moduleId: `folio_${name}` } : {}),
    ...(typeof manifest?.version === 'string' ? { packageVersion: manifest.version } : {})
  };
  const consider = (value: unknown, source: UiRuntimeTarget['source']): void => {
    if (typeof value !== 'string') return;
    if (!PLAIN_ROUTE.test(value)) {
      result.skipped.push({ path: value, source, reason: 'not a plain path such as /users' });
    } else if (!result.targets.some(target => target.path === value)) {
      result.targets.push({ path: value, source });
    }
  };
  consider(stripes?.route, 'route');
  consider(stripes?.home, 'home');
  if (typeof stripes?.route === 'string' && PLAIN_ROUTE.test(stripes.route)) result.targets.push({ path: `/settings${stripes.route}`, source: 'settings' });
  if (result.targets.length) result.targets.push({ path: '/settings/about', source: 'about' });
  return result;
}

export const NO_RUNTIME_EVIDENCE: Readonly<UiRuntimeEvidence> = emptyEvidence('not-configured');

function emptyEvidence(outcome: UiRuntimeEvidence['outcome'], problem?: string): UiRuntimeEvidence {
  return { outcome, ...(problem ? { problem } : {}), pages: [], skippedPaths: [], navigations: [], navigationsCut: 0, blockedRequests: [], blockedRequestsCut: 0 };
}

export function getUiRuntimeEvidence(run: EvaluationRun, source: FrontendSource): Promise<UiRuntimeEvidence> {
  return run.getOrCreateArtifact('uiRuntimeEvidence', async () => {
    const { targets, skipped, moduleId } = uiRuntimeTargets(source.packageJson);
    if (!run.uiRuntime) return { ...emptyEvidence('not-configured'), skippedPaths: skipped };
    if (!targets.length) {
      return { ...emptyEvidence('not-run', 'package.json names no stripes.route to visit'), skippedPaths: skipped };
    }
    const evidence = await run.uiRuntime.collect(targets, moduleId);
    return { ...evidence, skippedPaths: [...skipped, ...evidence.skippedPaths] };
  });
}

export interface PlaywrightUiRuntimeProbeOptions extends UiRuntimeOptions {
  username?: string;
  password?: string;
  limits?: Partial<UiRuntimeLimits>;
}

class ProbeStopped extends Error {}
class BudgetExceeded extends Error {}

interface ProbeState {
  phase: 'login' | 'pages';
  apiOrigin?: string;
  stopReason?: string;
  stop: (reason: string) => void;
  stopped: Promise<never>;
}

export class PlaywrightUiRuntimeProbe implements UiRuntimeProbe {
  private readonly uiOrigin: string;
  private readonly loginOrigin: string;
  private readonly limits: UiRuntimeLimits;

  constructor(private readonly options: PlaywrightUiRuntimeProbeOptions) {
    this.uiOrigin = parseUiRuntimeOrigin(options.url, '--ui-runtime-url');
    this.loginOrigin = parseUiRuntimeOrigin(options.loginOrigin, '--ui-runtime-login-origin');
    this.limits = { ...UI_RUNTIME_LIMITS, ...options.limits };
  }

  async collect(targets: UiRuntimeTarget[], moduleId: string | undefined): Promise<UiRuntimeEvidence> {
    const evidence: UiRuntimeEvidence = { ...emptyEvidence('not-run'), uiOrigin: this.uiOrigin, loginOrigin: this.loginOrigin };
    if (!this.options.username || !this.options.password) {
      return { ...evidence, problem: 'FOLIO_UI_USERNAME and FOLIO_UI_PASSWORD must both be set' };
    }
    const started = Date.now();
    const deadline = started + this.limits.totalTimeoutMs;
    evidence.startedAt = new Date(started).toISOString();
    evidence.axeVersion = axeVersion();
    evidence.skippedPaths = targets.slice(this.limits.maxPages)
      .map(target => ({ ...target, reason: `over the limit of ${this.limits.maxPages} pages` }));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-runtime-probe-'));
    const removeProfile = () => fs.rmSync(profile, { recursive: true, force: true });
    process.once('exit', removeProfile);
    try {
      fs.mkdirSync(path.join(profile, 'Default'));
      fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), NO_PRELOADING_PREFERENCES);
      let context: BrowserContext;
      try {
        const { chromium } = await import('playwright-core');
        context = await chromium.launchPersistentContext(profile, {
          headless: true,
          timeout: Math.max(1, deadline - Date.now()),
          serviceWorkers: 'block',
          acceptDownloads: false,
          ...(this.options.chromePath ? { executablePath: this.options.chromePath } : { channel: 'chrome' })
        });
      } catch (error) {
        return redactEvaluatorSecretsInValue({ ...evidence, problem: `Chrome could not be started: ${firstLine(errorMessage(error))}` });
      }
      try {
        evidence.browserVersion = context.browser()?.version();
        await this.run(context, targets.slice(0, this.limits.maxPages), moduleId, evidence, started, deadline);
      } finally {
        evidence.durationMs = Date.now() - started;
        await context.close().catch(() => undefined);
      }
      return redactEvaluatorSecretsInValue(evidence);
    } finally {
      process.off('exit', removeProfile);
      removeProfile();
    }
  }

  private async run(context: BrowserContext, targets: UiRuntimeTarget[], moduleId: string | undefined, evidence: UiRuntimeEvidence,
    started: number, deadline: number): Promise<void> {
    let rejectStopped: (error: Error) => void = () => undefined;
    const state: ProbeState = {
      phase: 'login',
      stopped: new Promise<never>((_resolve, reject) => { rejectStopped = reject; }),
      stop: reason => {
        if (state.stopReason) return;
        state.stopReason = reason;
        rejectStopped(new ProbeStopped(reason));
      }
    };
    state.stopped.catch(() => undefined);
    const at = () => Date.now() - started;
    const block = (record: Omit<UiRuntimeRequestRecord, 'atMs'>): void => {
      if (evidence.blockedRequests.length < this.limits.blockedRequests) evidence.blockedRequests.push({ ...record, url: this.recordedUrl(record.url), atMs: at() });
      else evidence.blockedRequestsCut++;
    };
    const cdp = await context.browser()!.newBrowserCDPSession();
    let mainFrameId: string | undefined;
    cdp.on('Fetch.requestPaused', event => {
      this.onPaused(cdp, event, state, evidence, mainFrameId, block, at)
        .catch(() => cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined));
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*', resourceType: 'Script', requestStage: 'Response' }] });
    await context.addInitScript({ content: NO_WORKERS_SCRIPT });
    const page = context.pages()[0] ?? await context.newPage();
    const pageSession = await context.newCDPSession(page);
    mainFrameId = (await pageSession.send('Page.getFrameTree')).frameTree.frame.id;
    await pageSession.detach();
    await context.routeWebSocket(/.*/, socket => {
      block({ method: 'WebSocket', url: socket.url(), reason: 'WebSocket connections are not opened' });
      socket.close();
    });
    page.on('dialog', dialog => { dialog.dismiss().catch(() => undefined); });

    let current: UiRuntimePage | undefined;
    const inFlight = new Set<Request>();
    let lastActivity = Date.now();
    const settle = (request: Request) => { inFlight.delete(request); lastActivity = Date.now(); };
    page.on('request', request => {
      const previous = request.redirectedFrom();
      if (previous) inFlight.delete(previous);
      inFlight.add(request);
      lastActivity = Date.now();
    });
    page.on('requestfinished', settle);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) inFlight.clear(); });
    page.on('requestfailed', request => {
      settle(request);
      const failure = request.failure()?.errorText ?? 'failed';
      if (current && !failure.startsWith(BLOCKED_ERROR)) this.addFailed(current, { method: request.method(), url: this.recordedUrl(request.url()), atMs: at(), reason: failure });
    });
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        const url = this.recordedUrl(response.url());
        const record = [...evidence.navigations].reverse().find(navigation => navigation.url === url && navigation.status === undefined);
        if (record) record.status = response.status();
      }
      if (current && response.status() >= 400) this.addFailed(current, { method: response.request().method(), url: this.recordedUrl(response.url()), atMs: at(), status: response.status() });
    });
    page.on('console', message => {
      if (current && message.type() === 'error' && !message.text().startsWith(`Failed to load resource: ${BLOCKED_ERROR}`)) this.addConsole(current, message.text());
    });
    page.on('pageerror', error => { if (current) this.addConsole(current, `Uncaught ${error.name}: ${error.message}`); });

    const remaining = (pageDeadline: number) => Math.max(0, Math.min(pageDeadline, deadline) - Date.now());
    const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BudgetExceeded()), ms); });
      try {
        return await Promise.race([promise, timeout, state.stopped]);
      } finally {
        clearTimeout(timer);
        promise.catch(() => undefined);
      }
    };
    const waitForQuiet = async (pageDeadline: number): Promise<void> => {
      const quietDeadline = Math.min(Date.now() + this.limits.maxQuietWaitMs, pageDeadline, deadline);
      while (Date.now() < quietDeadline && !(inFlight.size === 0 && Date.now() - lastActivity >= this.limits.quietMs)) {
        await within(new Promise(resolve => setTimeout(resolve, 100)), 1_000);
      }
    };

    try {
      const loginDeadline = Date.now() + this.limits.pageTimeoutMs;
      try {
        await this.login(page, state, within, () => remaining(loginDeadline));
        await waitForQuiet(loginDeadline);
      } catch (error) {
        if (error instanceof BudgetExceeded) state.stop(`logging in did not finish within ${seconds(this.limits.pageTimeoutMs)}`);
        else if (!(error instanceof ProbeStopped)) state.stop(`logging in stopped: ${firstLine(errorMessage(error))}`);
        throw new ProbeStopped(state.stopReason);
      }
      state.phase = 'pages';
      for (const target of targets) {
        if (state.stopReason) break;
        if (Date.now() >= deadline) {
          evidence.skippedPaths.push({ ...target, reason: `the ${seconds(this.limits.totalTimeoutMs)} budget for the probe ran out` });
          continue;
        }
        const pageStarted = Date.now();
        const pageDeadline = pageStarted + this.limits.pageTimeoutMs;
        const record: UiRuntimePage = { ...target, url: `${this.uiOrigin}${target.path}`, durationMs: 0, consoleErrors: [], consoleErrorsCut: 0,
          failedRequests: [], failedRequestsCut: 0 };
        current = record;
        try {
          const response = await within(page.goto(record.url, { waitUntil: 'load', timeout: remaining(pageDeadline) + 1_000 }), remaining(pageDeadline));
          if (response) record.status = response.status();
          await waitForQuiet(pageDeadline);
          if (this.recordedUrl(page.url()) !== record.url) record.finalUrl = this.recordedUrl(page.url());
          const origin = new URL(page.url()).origin;
          if (origin !== this.uiOrigin) {
            record.problem = `the page ended on ${origin}, not on the UI`;
          } else if (target.source === 'about') {
            const version = moduleId ? deployedVersion(await within(page.evaluate('document.body ? document.body.innerText : ""').then(String), remaining(pageDeadline)), moduleId) : undefined;
            if (moduleId && version) evidence.deployedModule = { id: moduleId, version };
          } else {
            record.axe = await within(this.runAxe(page), remaining(pageDeadline));
          }
        } catch (error) {
          if (error instanceof ProbeStopped) record.problem = 'the probe stopped during this page';
          else if (error instanceof BudgetExceeded || Date.now() >= Math.min(pageDeadline, deadline)) {
            record.problem = Date.now() >= deadline && deadline < pageDeadline
              ? `the ${seconds(this.limits.totalTimeoutMs)} budget for the probe ran out during this page`
              : `the page did not finish within ${seconds(this.limits.pageTimeoutMs)}`;
          } else record.problem = firstLine(errorMessage(error));
        }
        current = undefined;
        record.durationMs = Date.now() - pageStarted;
        evidence.pages.push(record);
      }
    } catch (error) {
      if (!(error instanceof ProbeStopped)) state.stop(firstLine(errorMessage(error)));
    } finally {
      current = undefined;
      evidence.apiOrigin = state.apiOrigin;
      evidence.outcome = state.stopReason ? 'stopped' : 'collected';
      if (state.stopReason) evidence.problem = state.stopReason;
    }
  }

  private async login(page: Page, state: ProbeState, within: <T>(promise: Promise<T>, ms: number) => Promise<T>,
    remaining: () => number): Promise<void> {
    await within(page.goto(`${this.uiOrigin}/`, { waitUntil: 'load', timeout: remaining() + 1_000 }), remaining());
    try {
      await within(page.waitForURL(url => url.origin === this.loginOrigin, { timeout: remaining() + 1_000 }), remaining());
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        state.stop(`the UI did not send the browser to the login origin ${this.loginOrigin} within ${seconds(this.limits.pageTimeoutMs)}`);
        throw new ProbeStopped(state.stopReason);
      }
      throw error;
    }
    const username = page.mainFrame().locator('input[name="username"]');
    const password = page.mainFrame().locator('input[name="password"]');
    await within(password.waitFor({ state: 'visible', timeout: remaining() + 1_000 }), remaining());
    const [usernameField, passwordField] = await within(Promise.all([username.elementHandle(), password.elementHandle()]), remaining());
    const onLoginOrigin = () => new URL(page.url()).origin === this.loginOrigin;
    if (!onLoginOrigin()) {
      state.stop(`the login form was not on the login origin ${this.loginOrigin}`);
      throw new ProbeStopped(state.stopReason);
    }
    await within(usernameField.fill(this.options.username!, { timeout: remaining() + 1_000 }), remaining());
    await within(passwordField.fill(this.options.password!, { timeout: remaining() + 1_000 }), remaining());
    if (!onLoginOrigin()) {
      state.stop(`the browser left the login origin ${this.loginOrigin} while the credentials were typed`);
      throw new ProbeStopped(state.stopReason);
    }
    await within(passwordField.press('Enter', { timeout: remaining() + 1_000 }), remaining());
    await within(page.waitForURL(url => url.origin === this.uiOrigin, { timeout: remaining() + 1_000 }), remaining());
  }

  private async onPaused(cdp: CDPSession, event: Protocol.Fetch.requestPausedPayload, state: ProbeState, evidence: UiRuntimeEvidence,
    mainFrameId: string | undefined, block: (record: Omit<UiRuntimeRequestRecord, 'atMs'>) => void, at: () => number): Promise<void> {
    const { requestId, request } = event;
    const method = request.method;
    const fail = async (): Promise<void> => { await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); };
    if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
      if (!state.apiOrigin && !state.stopReason && event.responseStatusCode === 200 && new URL(request.url).origin === this.uiOrigin) {
        const body = await cdp.send('Fetch.getResponseBody', { requestId });
        const found = stripesApiOrigins(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
        if (state.apiOrigin) {
          if (found.some(origin => origin !== state.apiOrigin)) state.stop(`the UI's scripts name more than one API origin: ${[state.apiOrigin, ...found].join(', ')}`);
        } else if (found.length > 1) state.stop(`the UI's stripes-config names more than one API origin: ${found.join(', ')}`);
        else if (found.length === 1 && !isSameSiteOrigin(this.uiOrigin, found[0])) {
          state.stop(`the UI's stripes-config names the API origin ${found[0]}, which is not on the UI's site`);
        } else if (found.length === 1) state.apiOrigin = found[0];
      }
      await cdp.send('Fetch.continueRequest', { requestId });
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      block({ method, url: request.url, reason: 'not a URL' });
      return fail();
    }
    const origin = url.origin;
    const document = event.resourceType === 'Document';
    if (document && mainFrameId !== undefined && event.frameId === mainFrameId) {
      if (evidence.navigations.length < this.limits.navigations) evidence.navigations.push({ method, url: this.recordedUrl(request.url), atMs: at() });
      else evidence.navigationsCut++;
    }
    if (document && state.phase === 'login' && origin !== this.uiOrigin && origin !== this.loginOrigin) {
      block({ method, url: request.url, reason: 'a page outside the UI and login origins during login' });
      state.stop(`during login the browser was sent to ${origin}, which is neither the UI nor the login origin`);
      return fail();
    }
    if (origin !== this.uiOrigin && origin !== this.loginOrigin && origin !== state.apiOrigin) {
      block({ method, url: request.url, reason: 'another origin' });
      return fail();
    }
    const preflight = method === 'OPTIONS' ? Object.entries(request.headers)
      .find(([name]) => name.toLowerCase() === 'access-control-request-method')?.[1].toUpperCase() : undefined;
    const effectiveMethod = preflight ?? method;
    if (effectiveMethod !== 'GET' && !(effectiveMethod === 'POST' && ((origin === this.loginOrigin && LOGIN_WRITE_PATH.test(url.pathname))
      || (origin === state.apiOrigin && API_WRITE_PATH.test(url.pathname))))) {
      block({ method, url: request.url, reason: 'not a GET request' });
      return fail();
    }
    await cdp.send('Fetch.continueRequest', { requestId });
  }

  private runAxe(page: Page): Promise<NonNullable<UiRuntimePage['axe']>> {
    const { nodesPerRule, nodeHtmlChars } = this.limits;
    const options = JSON.stringify({ runOnly: { type: 'tag', values: AXE_TAGS }, resultTypes: ['violations'] });
    return page.evaluate(axeSource()).then(() => page.evaluate(`axe.run(document, ${options})`)).then(raw => {
      const result = isRecord(raw) ? raw : {};
      const violations: UiRuntimeAxeViolation[] = (Array.isArray(result.violations) ? result.violations : []).filter(isRecord).map(violation => {
        const nodes = (Array.isArray(violation.nodes) ? violation.nodes : []).filter(isRecord);
        return {
          id: String(violation.id),
          ...(typeof violation.impact === 'string' ? { impact: violation.impact } : {}),
          help: String(violation.help ?? ''),
          ...(typeof violation.helpUrl === 'string' ? { helpUrl: violation.helpUrl } : {}),
          nodeCount: nodes.length,
          nodes: nodes.slice(0, nodesPerRule).map(node => ({
            target: (Array.isArray(node.target) ? node.target.flat(4) : []).map(String).join(' '),
            html: String(node.html ?? '').slice(0, nodeHtmlChars)
          }))
        };
      });
      return {
        violations,
        passCount: Array.isArray(result.passes) ? result.passes.length : 0,
        incompleteCount: Array.isArray(result.incomplete) ? result.incomplete.length : 0
      };
    });
  }

  private recordedUrl(url: string): string {
    let recorded: string;
    try {
      const parsed = new URL(url);
      recorded = parsed.protocol === 'data:' || parsed.protocol === 'blob:' ? `${parsed.protocol}…` : `${parsed.origin}${parsed.pathname}`;
    } catch {
      recorded = url;
    }
    return recorded.slice(0, this.limits.urlChars);
  }

  private addConsole(page: UiRuntimePage, text: string): void {
    if (page.consoleErrors.length < this.limits.consolePerPage) page.consoleErrors.push(text.slice(0, this.limits.consoleChars));
    else page.consoleErrorsCut++;
  }

  private addFailed(page: UiRuntimePage, record: UiRuntimeRequestRecord): void {
    if (page.failedRequests.length < this.limits.failedRequestsPerPage) page.failedRequests.push(record);
    else page.failedRequestsCut++;
  }
}

export function stripesApiOrigins(script: string): string[] {
  const origins = new Set<string>();
  STRIPES_OKAPI_CONFIG.lastIndex = 0;
  for (let match = STRIPES_OKAPI_CONFIG.exec(script); match; match = STRIPES_OKAPI_CONFIG.exec(script)) {
    const start = match.index + match[0].length;
    const objectText = script.slice(start, start + MAX_CONFIG_OBJECT_CHARS);
    const end = objectText.indexOf('}');
    const url = STRIPES_OKAPI_URL.exec(end < 0 ? objectText : objectText.slice(0, end))?.[1];
    if (!url) continue;
    try {
      origins.add(new URL(url).origin);
    } catch {
      continue;
    }
  }
  return [...origins];
}

export function deployedVersion(aboutText: string, moduleId: string): string | undefined {
  const text = aboutText.slice(0, MAX_ABOUT_TEXT_CHARS);
  const marker = `${moduleId}-`;
  for (let index = text.indexOf(marker); index >= 0; index = text.indexOf(marker, index + 1)) {
    if (index > 0 && /\S/.test(text[index - 1])) continue;
    const version = DEPLOYED_VERSION.exec(text.slice(index + marker.length, index + marker.length + 64))?.[0];
    if (version) return version;
  }
  return undefined;
}

let axeScript: string | undefined;
function axeSource(): string {
  axeScript ??= fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeScript;
}

function axeVersion(): string {
  return (JSON.parse(fs.readFileSync(require.resolve('axe-core/package.json'), 'utf8')) as { version: string }).version;
}

function firstLine(text: string): string {
  return text.split('\n')[0].slice(0, 300);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}
