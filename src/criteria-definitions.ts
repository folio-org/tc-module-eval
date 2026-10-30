/**
 * Centralized definitions of all FOLIO technical council acceptance criteria
 * This file serves as the single source of truth for all criterion IDs and their organization
 *
 * Source: https://raw.githubusercontent.com/folio-org/tech-council/refs/heads/criteria-ids/MODULE_ACCEPTANCE_CRITERIA.MD
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
  section: CriterionSection;
  languages: readonly CriterionLanguage[];
  defaultEvaluation?: CriterionDefaultEvaluation;
}

const HUMAN_REVIEW_DETAILS = 'This criterion requires manual evaluation by a human reviewer';

/**
 * Complete catalog of all FOLIO technical council acceptance criteria.
 * The catalog owns canonical order, applicability, and fallback evaluation text.
 */
export const ACCEPTANCE_CRITERION_CATALOG = [
  {
    id: 'A001',
    description: 'Listed by Product Council with positive evaluation result',
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
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S002',
    description: 'Module build produces valid module descriptor',
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
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S004',
    description: 'Installation documentation included',
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
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S011',
    description: 'Passes Sonarqube security checks',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S012',
    description: 'Uses officially supported build tools',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S013',
    description: '80%+ unit test coverage',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },
  {
    id: 'S014',
    description: 'Assigned to one application descriptor',
    section: 'Shared/Common',
    languages: ['java', 'javascript']
  },

  {
    id: 'B001',
    description: 'Compliant Module Descriptor',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B002',
    description: 'API interface requirements in module descriptor',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Database design and schema management'
    }
  },
  {
    id: 'B003',
    description: 'Implement all endpoints in Module Descriptor',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B004',
    description: 'Environment vars documented',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Authentication and authorization'
    }
  },
  {
    id: 'B005',
    description: 'Provide interfaces per naming conventions',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B006',
    description: 'OpenAPI documentation for endpoints',
    section: 'Backend',
    languages: ['java']
  },
  {
    id: 'B007',
    description: 'Appropriate endpoint permissions',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Event-driven architecture'
    }
  },
  {
    id: 'B008',
    description: 'Provide reference data',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Microservice architecture compliance'
    }
  },
  {
    id: 'B009',
    description: 'Integration tests in supported technology',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Health checks and monitoring endpoints'
    }
  },
  {
    id: 'B010',
    description: 'Tenant data segregation',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Scalability and load handling'
    }
  },
  {
    id: 'B011',
    description: 'Restricted database schema access',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Data migration and backward compatibility'
    }
  },
  {
    id: 'B012',
    description: 'Dependencies declared in README',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Environment configuration'
    }
  },
  {
    id: 'B013',
    description: 'Respond with tenant-specific content',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Dependency injection and IoC'
    }
  },
  {
    id: 'B014',
    description: 'Standard health check endpoint',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'API versioning strategy'
    }
  },
  {
    id: 'B015',
    description: 'High Availability compliance',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Resource management'
    }
  },
  {
    id: 'B016',
    description: 'Use only supported infrastructure technologies',
    section: 'Backend',
    languages: ['java'],
    defaultEvaluation: {
      type: 'not_implemented',
      reason: 'Integration testing'
    }
  },

  {
    id: 'F001',
    description: 'API interface requirements in package.json',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F002',
    description: 'E2E tests in supported technology',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F003',
    description: 'i18n support via react-intl',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F004',
    description: 'WCAG 2.1 AA compliance',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F005',
    description: 'Use specified Stripes version',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F006',
    description: 'Follow existing UI layouts/patterns',
    section: 'Frontend',
    languages: ['javascript']
  },
  {
    id: 'F007',
    description: 'Works in latest Chrome',
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
