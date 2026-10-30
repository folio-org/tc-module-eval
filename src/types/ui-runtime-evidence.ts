export interface UiRuntimeTarget {
  path: string;
  source: 'route' | 'home' | 'settings' | 'about';
}

export interface UiRuntimeSkippedPath extends UiRuntimeTarget {
  reason: string;
}

export interface UiRuntimeRequestRecord {
  method: string;
  url: string;
  atMs: number;
  status?: number;
  reason?: string;
}

export interface UiRuntimeAxeNode {
  target: string;
  html: string;
}

export interface UiRuntimeAxeViolation {
  id: string;
  impact?: string;
  help: string;
  helpUrl?: string;
  nodeCount: number;
  nodes: UiRuntimeAxeNode[];
}

export interface UiRuntimePage extends UiRuntimeTarget {
  url: string;
  finalUrl?: string;
  status?: number;
  durationMs: number;
  problem?: string;
  axe?: { violations: UiRuntimeAxeViolation[]; passCount: number; incompleteCount: number };
  consoleErrors: string[];
  consoleErrorsCut: number;
  failedRequests: UiRuntimeRequestRecord[];
  failedRequestsCut: number;
}

export interface UiRuntimeEvidence {
  outcome: 'not-configured' | 'not-run' | 'stopped' | 'collected';
  problem?: string;
  uiOrigin?: string;
  loginOrigin?: string;
  apiOrigin?: string;
  startedAt?: string;
  durationMs?: number;
  browserVersion?: string;
  axeVersion?: string;
  deployedModule?: { id: string; version: string };
  pages: UiRuntimePage[];
  skippedPaths: UiRuntimeSkippedPath[];
  navigations: UiRuntimeRequestRecord[];
  navigationsCut: number;
  blockedRequests: UiRuntimeRequestRecord[];
  blockedRequestsCut: number;
}

export interface UiRuntimeProbe {
  collect(targets: UiRuntimeTarget[], moduleId: string | undefined): Promise<UiRuntimeEvidence>;
}
