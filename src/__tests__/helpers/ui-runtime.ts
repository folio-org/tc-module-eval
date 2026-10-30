import { UiRuntimeEvidence, UiRuntimeProbe, UiRuntimeTarget } from '../../types';

export const RUNTIME: UiRuntimeEvidence = {
  outcome: 'collected',
  uiOrigin: 'https://folio-etesting-snapshot-diku.ci.folio.org',
  loginOrigin: 'https://folio-etesting-snapshot-keycloak.ci.folio.org',
  apiOrigin: 'https://folio-etesting-snapshot-kong.ci.folio.org',
  startedAt: '2026-10-30T12:00:00.000Z',
  durationMs: 14_400,
  browserVersion: '156.0.8078.47',
  axeVersion: '4.14.0',
  deployedModule: { id: 'folio_example', version: '2.1.1099000000000453' },
  pages: [
    { path: '/example', source: 'route', url: 'https://folio-etesting-snapshot-diku.ci.folio.org/example',
      finalUrl: 'https://folio-etesting-snapshot-diku.ci.folio.org/example?sort=name', status: 200, durationMs: 2_500,
      axe: { passCount: 30, incompleteCount: 1, violations: [
        { id: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', nodeCount: 2,
          nodes: [{ target: '#pane-results .mclEmptyMessage', html: '<div class="mclEmptyMessage">No results</div>' },
            { target: '#paneHeader h2', html: '<h2>Example</h2>' }] },
        { id: 'aria-allowed-attr', impact: 'critical', help: 'Elements must only use supported ARIA attributes', nodeCount: 1,
          nodes: [{ target: 'nav', html: '<nav aria-checked="true">' }] }
      ] },
      consoleErrors: ['Failed to load resource: the server responded with a status of 501 ()'], consoleErrorsCut: 0,
      failedRequests: [{ method: 'GET', url: 'https://folio-etesting-snapshot-kong.ci.folio.org/_/env', atMs: 5_000, status: 501 }], failedRequestsCut: 0 },
    { path: '/settings/example', source: 'settings', url: 'https://folio-etesting-snapshot-diku.ci.folio.org/settings/example', status: 200,
      durationMs: 2_400, axe: { passCount: 25, incompleteCount: 0, violations: [] }, consoleErrors: [], consoleErrorsCut: 0, failedRequests: [], failedRequestsCut: 0 },
    { path: '/settings/about', source: 'about', url: 'https://folio-etesting-snapshot-diku.ci.folio.org/settings/about', status: 200,
      durationMs: 2_300, consoleErrors: [], consoleErrorsCut: 0, failedRequests: [], failedRequestsCut: 0 }
  ],
  skippedPaths: [],
  navigations: [{ method: 'GET', url: 'https://folio-etesting-snapshot-diku.ci.folio.org/', atMs: 500, status: 200 }],
  navigationsCut: 0,
  blockedRequests: [{ method: 'GET', url: 'https://eureka-customer-assets.s3.us-west-2.amazonaws.com/diku/logo.png', atMs: 3_000, reason: 'another origin' }],
  blockedRequestsCut: 0
};

export class FakeProbe implements UiRuntimeProbe {
  calls: Array<{ targets: UiRuntimeTarget[]; moduleId?: string }> = [];
  constructor(private readonly evidence: UiRuntimeEvidence) {}
  async collect(targets: UiRuntimeTarget[], moduleId: string | undefined): Promise<UiRuntimeEvidence> {
    this.calls.push({ targets, moduleId });
    return this.evidence;
  }
}
