import { UiRuntimeEvidence, UiRuntimePage } from '../types';
import { count, reportText } from './report-text';

/** The probe measured at least one of the module's pages, not only the about page. */
export function runtimeCollected(runtime: UiRuntimeEvidence): boolean {
  return runtime.pages.some(page => page.axe);
}

export function runtimeNotRunReason(criterionId: string, runtime: UiRuntimeEvidence): string {
  return runtime.outcome === 'not-configured'
    ? `${criterionId} agent review needs runtime evidence from a running FOLIO UI (--ui-runtime-url and --ui-runtime-login-origin), and none was given`
    : `${criterionId} agent review needs runtime evidence, and the probe of the running UI collected none (see "Runtime evidence")`;
}

export function consoleErrorCount(pages: UiRuntimePage[]): number {
  return pages.reduce((total, page) => total + page.consoleErrors.length + page.consoleErrorsCut, 0);
}

export function failedRequestCount(pages: UiRuntimePage[]): number {
  return pages.reduce((total, page) => total + page.failedRequests.length + page.failedRequestsCut, 0);
}

const SKIPPED_SOURCES: Record<string, string> = { route: 'stripes.route', home: 'stripes.home', settings: 'settings', about: 'about page' };

/** The "Runtime evidence" rows of an F criterion's details. */
export function runtimeEvidenceLines(runtime: UiRuntimeEvidence, packageVersion: string | undefined,
  options: { notConfigured: string; tools?: string; pageResult: (page: UiRuntimePage) => string }): string[] {
  if (runtime.outcome === 'not-configured') {
    return ['Runtime evidence:', `  - Not collected; ${options.notConfigured}`];
  }
  if (runtime.outcome === 'not-run') {
    return ['Runtime evidence:', `  - Not collected: ${reportText(runtime.problem ?? 'the probe did not run')}`];
  }
  const consoleErrors = runtime.pages.flatMap(page => page.consoleErrors);
  const consolePages = runtime.pages.filter(page => page.consoleErrors.length).length;
  const consoleTotal = consoleErrorCount(runtime.pages);
  const failed = runtime.pages.flatMap(page => page.failedRequests);
  const failedTotal = failedRequestCount(runtime.pages);
  const blocked = runtime.blockedRequests;
  const deployed = runtime.deployedModule;
  return [
    'Runtime evidence (informational):',
    `  - UI ${reportText(runtime.uiOrigin ?? '')}, login ${reportText(runtime.loginOrigin ?? '')}, API ${reportText(runtime.apiOrigin ?? 'not found')}; `
      + `Chrome ${reportText(runtime.browserVersion ?? 'unknown')}${options.tools ?? ''}; took ${Math.round((runtime.durationMs ?? 0) / 1000)} s`,
    `  - Deployed module: ${deployed ? `${reportText(deployed.id)} ${reportText(deployed.version)} on /settings/about` : 'version not found on /settings/about'}`
      + `; package.json of this commit: ${reportText(packageVersion ?? 'no version')}`,
    ...runtime.pages.map(page => `  - ${reportText(page.path)}${page.finalUrl ? ` (ended on ${reportText(page.finalUrl)})` : ''}: ${page.problem
      ? reportText(page.problem) : options.pageResult(page)}`),
    ...runtime.skippedPaths.map(skipped => `  - ${reportText(skipped.path)} (${SKIPPED_SOURCES[skipped.source]}): not visited — ${reportText(skipped.reason)}`),
    `  - Console errors: ${consoleTotal ? `${consoleTotal} on ${count(consolePages, 'page')}; first: `
      + consoleErrors.slice(0, 3).map(message => `"${reportText(message.replace(/\s+/g, ' ').slice(0, 160))}"`).join('; ') : 'none'}`,
    `  - Failed requests: ${failedTotal ? `${failedTotal}; first: ${failed.slice(0, 3).map(request =>
      `${request.status ? `HTTP ${request.status}` : reportText(request.reason ?? 'failed')} ${reportText(request.method)} ${reportText(request.url.slice(0, 160))}`).join('; ')}` : 'none'}`,
    `  - Blocked requests: ${blocked.length + runtime.blockedRequestsCut ? `${blocked.length + runtime.blockedRequestsCut}; first: ${blocked.slice(0, 3).map(request =>
      `${reportText(request.method)} ${reportText(request.url.slice(0, 160))} (${reportText(request.reason ?? '')})`).join('; ')}` : 'none'}`,
    ...(runtime.outcome === 'stopped' ? [`  - Stopped: ${reportText(runtime.problem ?? '')}`] : [])
  ];
}
