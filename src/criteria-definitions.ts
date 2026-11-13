/**
 * Centralized definitions of all FOLIO technical council acceptance criteria
 * This catalog provides criterion IDs, summaries, and organization for the evaluator
 *
 * Source: ../MODULE_ACCEPTANCE_CRITERIA.MD
 */

import { CriterionResult, EvaluationStatus } from './types';

export interface CriterionDefinition {
  id: string;
  description: string;
  section: string;
}

export type CriterionSection = 'Administrative' | 'Shared/Common' | 'Backend' | 'Frontend';
export type CriterionLanguage = 'java' | 'javascript';

export interface CriterionDefaultEvaluation {
  type: 'manual_review' | 'not_implemented';
  reason: string;
  languageReasons?: Partial<Record<CriterionLanguage, string>>;
}

export interface AcceptanceCriterionDefinition extends CriterionDefinition {
  summary: string;
  section: CriterionSection;
  languages: readonly CriterionLanguage[];
  defaultEvaluation?: CriterionDefaultEvaluation;
}

export const HUMAN_REVIEW_DETAILS = 'This criterion requires manual evaluation by a human reviewer';

/**
 * Complete catalog of all FOLIO technical council acceptance criteria.
 * The catalog owns canonical order, applicability, and fallback evaluation text.
 */
export const ACCEPTANCE_CRITERION_CATALOG = [
  {
    id: 'A001',
    description: 'Listed by Product Council with positive evaluation result',
    summary: 'Listed by the Product Council with a positive evaluation result.',
    section: 'Administrative',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'manual_review',
      reason: 'Product Council approval verification requires manual review'
    }
  },

  {
    id: 'S001',
    description: 'Uses Apache 2.0 license',
    summary: 'The module is licensed under the Apache License 2.0.',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S002',
    description: 'Module build produces valid module descriptor',
    summary: 'The module build produces a valid module descriptor.',
    section: 'Shared/Common',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Module descriptor validation',
      languageReasons: {
        javascript: 'package.json and stripes metadata validation'
      }
    }
  },
  {
    id: 'S003',
    description: 'Third-party dependencies comply with ASF license policy',
    summary: 'Third-party dependencies comply with the ASF 3rd Party License Policy.',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S004',
    description: 'Installation documentation included',
    summary: 'The repository includes documentation on installing the module.',
    section: 'Shared/Common',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'README file evaluation'
    }
  },
  {
    id: 'S005',
    description: 'Personal data form completed',
    summary: 'A completed, accurate personal data form is provided as PERSONAL_DATA_DISCLOSURE.md.',
    section: 'Shared/Common',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Personal data disclosure form evaluation'
    }
  },
  {
    id: 'S006',
    description: 'No sensitive info in git repository',
    summary: 'No sensitive or environment-specific information is checked into the git repository.',
    section: 'Shared/Common',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Sensitive information repository scan'
    }
  },
  {
    id: 'S007',
    description: 'Written in officially supported technologies',
    summary: 'Written in a language and framework from the Officially Supported Technologies list.',
    section: 'Shared/Common',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Testing requirements',
      languageReasons: {
        javascript: 'Supported technologies (React, Node.js, Stripes)'
      }
    }
  },
  {
    id: 'S008',
    description: 'Uses existing FOLIO interfaces',
    summary: 'Uses only FOLIO interfaces provided by previously accepted modules.',
    section: 'Shared/Common',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Documentation requirements',
      languageReasons: {
        javascript: 'FOLIO Stripes interface usage'
      }
    }
  },
  {
    id: 'S009',
    description: 'No unapproved FOLIO library dependencies',
    summary: 'Depends only on FOLIO libraries approved through the TCR process.',
    section: 'Shared/Common',
    languages: ['java', 'javascript'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Security requirements',
      languageReasons: {
        javascript: 'Approved npm package dependencies'
      }
    }
  },
  {
    id: 'S010',
    description: 'Gracefully handles the absence of third party systems or related configuration',
    summary: 'Handles the absence of optional third-party systems or their configuration gracefully.',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S011',
    description: 'Passes Sonarqube security checks',
    summary: 'SonarQube finds no security issues, no high or greater severity issues and at most 3% duplication; disabled or ignored rules are reasonably justified.',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S012',
    description: 'Uses officially supported build tools',
    summary: 'Builds with officially supported build tools.',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S013',
    description: '80%+ unit test coverage',
    summary: 'Unit tests cover at least 80% of the code and use officially supported technologies.',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S014',
    description: 'Assigned to one application descriptor',
    summary: 'Assigned to exactly one application descriptor in the FOLIO Community LSP Platform, the one named in the evaluation\'s Jira task.',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },

  {
    id: 'B001',
    description: 'Compliant Module Descriptor',
    summary: 'The repository includes a module descriptor that complies with the Okapi schema.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B002',
    description: 'API interface requirements in module descriptor',
    summary: 'The module descriptor lists every consumed interface in requires or optional.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B003',
    description: 'Implement all endpoints in Module Descriptor',
    summary: 'The module implements every endpoint in the provides section of its module descriptor.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B004',
    description: 'Environment vars documented',
    summary: 'Environment variables follow the FOLIO environment variables policy.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B005',
    description: 'Provide interfaces per naming conventions',
    summary: 'Interfaces for other modules are in the descriptor\'s provides section and follow FOLIO naming conventions.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B006',
    description: 'OpenAPI documentation for endpoints',
    summary: 'All API endpoints are documented in OpenAPI; existing RMB-based modules may use RAML instead.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B007',
    description: 'Appropriate endpoint permissions',
    summary: 'Every API endpoint is protected by appropriate permissions that follow the naming guidelines.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B008',
    description: 'Provide reference data',
    summary: 'The module provides reference data where it needs at least one value, such as for a controlled vocabulary.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B009',
    description: 'Integration tests in supported technology',
    summary: 'Integration (API) tests, if provided, are written in an officially supported technology.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B010',
    description: 'Tenant data segregation',
    summary: 'Data is segregated by tenant at the storage layer.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B011',
    description: 'Restricted database schema access',
    summary: 'The module accesses no database schema other than its own and public, except through the FOLIO Query Machine.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B012',
    description: 'Dependencies declared in README',
    summary: 'README.md declares every dependency other than defined interfaces.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B013',
    description: 'Respond with tenant-specific content',
    summary: 'The module returns a tenant\'s content based on the X-Okapi-Tenant header.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B014',
    description: 'Standard health check endpoint',
    summary: 'GET /admin/health returns a 200 response.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B015',
    description: 'High Availability compliance',
    summary: 'The module is high-availability compliant; sticky sessions, local container storage and stateful services are red flags.',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B016',
    description: 'Use only supported infrastructure technologies',
    summary: 'Uses only infrastructure technologies on the Officially Supported Technologies list.',
    section: 'Backend',
    languages: ['java']
  },

  {
    id: 'F001',
    description: 'API interface requirements in package.json',
    summary: 'package.json lists every consumed interface in okapiInterfaces or optionalOkapiInterfaces.',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F002',
    description: 'E2E tests in supported technology',
    summary: 'End-to-end tests, if provided, are written in an officially supported technology.',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F003',
    description: 'i18n support via react-intl',
    summary: 'Has i18n support via react-intl and an en.json file with the English texts.',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F004',
    description: 'WCAG 2.1 AA compliance',
    summary: 'Meets WCAG 2.1 AA as measured by a current major version of axe DevTools.',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F005',
    description: 'Use specified Stripes version',
    summary: 'Uses the Stripes version named on the Officially Supported Technologies page.',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F006',
    description: 'Follow existing UI layouts/patterns',
    summary: 'Follows relevant existing FOLIO UI layouts, patterns and norms.',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F007',
    description: 'Works in latest Chrome',
    summary: 'Works in the latest version of Chrome.',
    section: 'Frontend',
    languages: ['javascript']
  }
] as const satisfies readonly AcceptanceCriterionDefinition[];

export type AcceptanceCriterion = AcceptanceCriterionDefinition;
type CatalogCriterion = typeof ACCEPTANCE_CRITERION_CATALOG[number];
export type CriterionId = CatalogCriterion['id'];
export type AdministrativeCriterionId = Extract<CatalogCriterion, { section: 'Administrative' }>['id'];
export type SharedCriterionId = Extract<CatalogCriterion, { section: 'Shared/Common' }>['id'];
export type BackendCriterionId = Extract<CatalogCriterion, { section: 'Backend' }>['id'];
export type FrontendCriterionId = Extract<CatalogCriterion, { section: 'Frontend' }>['id'];
export type JavaCriterionId = AdministrativeCriterionId | SharedCriterionId | BackendCriterionId;

type CriteriaIdsForSection<
  Catalog extends readonly { id: string; section: CriterionSection }[],
  Section extends CriterionSection,
  Result extends readonly string[] = readonly []
> = Catalog extends readonly [infer Head, ...infer Tail]
  ? Head extends { id: string; section: CriterionSection }
    ? Tail extends readonly { id: string; section: CriterionSection }[]
      ? Head['section'] extends Section
        ? CriteriaIdsForSection<Tail, Section, readonly [...Result, Head['id']]>
        : CriteriaIdsForSection<Tail, Section, Result>
      : Result
    : Result
  : Result;

/**
 * Build the canonical, ordered list of criterion IDs for a section.
 *
 * The return TYPE is derived from the catalog via {@link CriteriaIdsForSection},
 * so it can never silently drift from the data. The single assertion only bridges
 * the runtime `filter`/`map` result (which TypeScript widens to `string[]`) to that
 * catalog-derived tuple type — both sides apply the same `section` predicate to the
 * same catalog, so they are consistent by construction.
 */
function criteriaIdsForSection<S extends CriterionSection>(
  section: S
): CriteriaIdsForSection<typeof ACCEPTANCE_CRITERION_CATALOG, S> {
  return (ACCEPTANCE_CRITERION_CATALOG as readonly AcceptanceCriterionDefinition[])
    .filter(criterion => criterion.section === section)
    .map(criterion => criterion.id) as CriteriaIdsForSection<typeof ACCEPTANCE_CRITERION_CATALOG, S>;
}

export const ADMINISTRATIVE_CRITERIA = criteriaIdsForSection('Administrative');

export const SHARED_CRITERIA = criteriaIdsForSection('Shared/Common');

export const BACKEND_CRITERIA = criteriaIdsForSection('Backend');

export const FRONTEND_CRITERIA = criteriaIdsForSection('Frontend');

export function getCriteriaForLanguage(language: string): readonly string[] {
  switch (language.toLowerCase()) {
    case 'java':
      return getCriteriaForCatalogLanguage('java');
    case 'javascript':
    case 'typescript':
    case 'react':
      return getCriteriaForCatalogLanguage('javascript');
    default:
      throw new Error(
        `Unsupported language: ${language}. ` +
        `Supported languages are: java, javascript, typescript, react`
      );
  }
}

export function getCriteriaForCatalogLanguage(language: CriterionLanguage): readonly string[] {
  return (ACCEPTANCE_CRITERION_CATALOG as readonly AcceptanceCriterionDefinition[])
    .filter(criterion => criterion.languages.includes(language))
    .map(criterion => criterion.id);
}

export function getCriteriaForSection(
  section: CriterionSection,
  language: CriterionLanguage
): readonly string[] {
  return (ACCEPTANCE_CRITERION_CATALOG as readonly AcceptanceCriterionDefinition[])
    .filter(criterion => criterion.section === section && criterion.languages.includes(language))
    .map(criterion => criterion.id);
}

export function getAcceptanceCriterionDefinition(criterionId: string): AcceptanceCriterion | undefined {
  return ACCEPTANCE_CRITERION_CATALOG.find(criterion => criterion.id === criterionId);
}

/**
 * Create the catalog-defined fallback result for criteria without automated logic.
 */
export function createDefaultCriterionResult(
  criterionId: string,
  language: CriterionLanguage
): CriterionResult {
  const criterion = getAcceptanceCriterionDefinition(criterionId);
  if (!criterion?.defaultEvaluation) {
    throw new Error(`No default evaluation registered for criterion: ${criterionId}`);
  }

  const defaultEvaluation = criterion.defaultEvaluation;
  const reason = defaultEvaluation.languageReasons?.[language] || defaultEvaluation.reason;

  if (defaultEvaluation.type === 'manual_review') {
    return {
      criterionId,
      status: EvaluationStatus.MANUAL,
      evidence: reason,
      details: HUMAN_REVIEW_DETAILS
    };
  }

  return {
    criterionId,
    status: EvaluationStatus.MANUAL,
    evidence: `${reason} - evaluation logic not yet implemented`,
    details: HUMAN_REVIEW_DETAILS
  };
}
