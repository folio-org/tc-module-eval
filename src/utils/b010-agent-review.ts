import { B010Analysis, CommandRunner, CriterionAgentReviewConfig, CriterionAgentReviewResult } from '../types';
import { backendBrowse, buildBackendAgentReviewRequest } from './backend-agent-review';
import { CriterionAgentReviewRequest, runCriterionAgentReview, unavailableResult } from './criterion-agent-review';
import { givenObligations } from './frontend-agent-review';
import { redactEvaluatorSecrets } from './redaction';
import { errorMessage } from './type-guards';

const DB_SCRIPTS = /(?:^|\/)templates\/db_scripts\//;

export function hasB010AgentReviewMaterial(analysis: B010Analysis): boolean {
  return givenObligations(analysis.checklist).length > 0;
}

export async function reviewB010WithAgent(
  repoPath: string,
  analysis: B010Analysis,
  config: CriterionAgentReviewConfig | undefined,
  commandRunner?: CommandRunner
): Promise<CriterionAgentReviewResult> {
  let request: CriterionAgentReviewRequest;
  try {
    request = buildB010AgentReviewRequest(repoPath, analysis);
  } catch (error) {
    return { ...unavailableResult('B010'), errors: [redactEvaluatorSecrets(`Unable to prepare B010 agent review material: ${errorMessage(error)}`)] };
  }
  return runCriterionAgentReview(request, config, commandRunner);
}

export function buildB010AgentReviewRequest(repoPath: string, analysis: B010Analysis): CriterionAgentReviewRequest {
  const listed = new Set(analysis.checklist.items.flatMap(item => item.startingPoints.map(point => point.path)));
  return buildBackendAgentReviewRequest({
    criterionId: 'B010',
    repositoryPath: repoPath,
    criterionTitle: 'B010: each tenant\'s data is kept apart at the storage layer, in the tenant\'s own schema',
    checklist: analysis.checklist,
    discoveredKinds: [],
    browse: backendBrowse({
      include: path => DB_SCRIPTS.test(path) || listed.has(path),
      scope: 'templates/db_scripts/ in any module folder, and every file the checklist lists'
    }),
    criterionInstructions: [
      'FOLIO keeps each tenant\'s data in its own schema: RMB modules in <tenant>_<module> schemas through PostgresClient and PgUtil with the request\'s tenant, '
        + 'Spring modules through folio-spring-base, whose DataSource sets search_path to the tenant\'s schema and which runs Liquibase per tenant, '
        + 'and Grails modules through GORM multi-tenancy in SCHEMA mode with MultiTenant domain classes. Tables, functions and data in public or in a schema with a fixed name are shared by every tenant.',
      'B010-C1: from the starting points, read how the module creates and writes its tables (RMB schema.json and db_scripts, Liquibase changesets, JPA entities and repositories, '
        + 'JdbcTemplate SQL, GORM domain classes) and decide whether every table it writes is in the tenant\'s schema. Sample representative repositories or DAOs and say which files you read.',
      'B010-C2: each obligation is one file with places the tool listed in its starting points. aligned_fact when none of them stores or exposes data that belongs to one tenant where other tenants share it; '
        + 'substantive_concern when tenant data is stored in, or can be read or written across tenants through, a shared schema, table, function or connection; '
        + 'analyzer_limitation when the tool misread the code. Cite the file.',
      'B010-C3: look for in-memory caches (Caffeine, Spring @Cacheable, static maps), local files and temporary directories that hold tenant data, and check that each is keyed or separated by tenant. '
        + 'When the module has none, use aligned_fact with coverageDisposition immaterial and cite the file that shows it.'
    ],
    evidenceSummary: maxEntries => {
      const list = <T>(items: T[]) => ({ items: items.slice(0, maxEntries), ...(items.length > maxEntries ? { omitted: items.length - maxEntries } : {}) });
      return {
        criterionId: 'B010',
        deterministicStatus: analysis.status,
        summary: analysis.summary,
        repositoryKind: analysis.kind,
        storage: analysis.storage,
        mechanisms: analysis.mechanisms,
        sharedStoragePlaces: { ...list(analysis.redFlags), total: analysis.redFlagCount },
        unreadClientCalls: list(analysis.unreadClientCalls),
        unreadFiles: list(analysis.sourceDiagnostics.map(diagnostic => diagnostic.path ?? diagnostic.message))
      };
    }
  });
}
