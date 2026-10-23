// Trims recorded SonarCloud responses to the fields src/utils/sonarcloud-snapshot.ts reads, so fixtures stay
// small and are re-recorded reproducibly rather than hand-edited. Every request URL is kept; totals, paging and
// facets are kept exactly. src/__tests__/s011-sonarqube.test.ts fails if the evaluator reads a field outside
// these lists, so a new read must be added here before the fixtures are re-recorded.

/**
 * Per endpoint (the path after /api/), the fields kept. A path keeps its whole subtree; `[]` stands for every
 * array element. Endpoints not listed are small and kept whole.
 */
export const SONARCLOUD_KEPT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'project_branches/list': ['branches[].name', 'branches[].isMain'],
  'issues/search': [
    'total', 'p', 'ps', 'paging', 'facets',
    'issues[].rule', 'issues[].component', 'issues[].line', 'issues[].message', 'issues[].impacts'
  ],
  'hotspots/search': [
    'paging',
    'hotspots[].ruleKey', 'hotspots[].component', 'hotspots[].line', 'hotspots[].vulnerabilityProbability', 'hotspots[].securityCategory'
  ],
  'qualityprofiles/search': ['profiles[].language', 'profiles[].name', 'profiles[].isDefault'],
  'rules/search': ['total', 'p', 'ps', 'rules[].key', 'rules[].name', 'rules[].type', 'rules[].impacts']
};

export type RecordedResponse = { status: number; body: unknown };

/** The endpoint a SonarCloud API URL calls, such as issues/search; undefined for other hosts. */
export function sonarCloudEndpoint(url: string): string | undefined {
  const parsed = new URL(url);
  return parsed.hostname === 'sonarcloud.io' && parsed.pathname.startsWith('/api/') ? parsed.pathname.slice('/api/'.length) : undefined;
}

/**
 * The recorded responses with each SonarCloud body trimmed. Quality profiles are also cut to the languages the
 * project uses (from navigation/component), plus any profile that is not the organization default: the only
 * ones the report mentions. The read check in the S011 tests covers fields, not dropped rows, so keep row
 * filters to that one.
 */
export function trimSonarCloudResponses(responses: Readonly<Record<string, RecordedResponse>>): Record<string, RecordedResponse> {
  const languages = projectLanguages(responses);
  return Object.fromEntries(Object.entries(responses).map(([url, response]) => {
    const endpoint = sonarCloudEndpoint(url);
    const kept = endpoint ? SONARCLOUD_KEPT_FIELDS[endpoint] : undefined;
    if (!kept || response.status !== 200 || !isObject(response.body)) return [url, response];
    let body = keep(response.body, tree(kept)) as Record<string, unknown>;
    if (endpoint === 'qualityprofiles/search' && Array.isArray(body.profiles) && languages) {
      body = { ...body, profiles: body.profiles.filter(item => isObject(item) && (item.isDefault !== true || languages.has(item.language as string))) };
    }
    return [url, { ...response, body }];
  }));
}

function projectLanguages(responses: Readonly<Record<string, RecordedResponse>>): Set<string> | undefined {
  const navigation = Object.entries(responses).find(([url]) => sonarCloudEndpoint(url) === 'navigation/component')?.[1];
  const profiles = isObject(navigation?.body) ? navigation!.body.qualityProfiles : undefined;
  if (!Array.isArray(profiles) || !profiles.every(item => isObject(item) && typeof item.language === 'string')) return undefined;
  return new Set(profiles.map(item => (item as { language: string }).language));
}

type Tree = { [key: string]: Tree | true };

function tree(paths: readonly string[]): Tree {
  const root: Tree = {};
  for (const path of paths) {
    const parts = path.replace(/\[\]/g, '.[]').split('.');
    let node = root;
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1) node[part] = true;
      else if (node[part] === true) break;
      else node = (node[part] ??= {}) as Tree;
    }
  }
  return root;
}

function keep(value: unknown, shape: Tree | true): unknown {
  if (shape === true) return value;
  if (Array.isArray(value)) return shape['[]'] ? value.map(item => keep(item, shape['[]'])) : value;
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => Object.prototype.hasOwnProperty.call(shape, key))
    .map(([key, item]) => [key, keep(item, shape[key])]));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
