import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  DEFAULT_S007_POLICY_PATH,
  loadS007Policy,
  normalizeS007PolicyVersionExpression
} from '../utils/s007-policy';

describe('S007 OST policy', () => {
  let fixtureDir: string;

  beforeEach(async () => {
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 's007-policy-'));
  });

  afterEach(async () => {
    await fs.remove(fixtureDir);
  });

  it('loads the complete committed policy and preserves source meaning', async () => {
    const result = await loadS007Policy();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.diagnostics.map(diagnostic => diagnostic.message).join('\n'));
    }

    expect(result.policy.formatVersion).toBe('1.0');
    expect(result.policy.sections.map(section => section.id)).toEqual(expect.arrayContaining([
      'frontend-languages',
      'frontend-build-tools',
      'frontend-first-party-frameworks',
      'frontend-third-party-frameworks',
      'frontend-build-testing',
      'frontend-integration-testing',
      'backend-languages',
      'backend-build-tools',
      'backend-first-party-frameworks',
      'backend-third-party-frameworks',
      'backend-build-testing',
      'backend-integration-testing',
      'infrastructure',
      'fast-moving-infrastructure'
    ]));

    const gradle = findEntry(result.policy, 'gradle');
    const make = findEntry(result.policy, 'make');
    const cypress = findEntry(result.policy, 'cypress');
    expect([gradle.strength, make.strength, cypress.strength]).toEqual([
      'provisional',
      'provisional',
      'provisional'
    ]);
    expect(gradle.constraint).toBeUndefined();
    expect(make.constraint).toBeUndefined();

    const springBoot = findEntry(result.policy, 'spring-boot');
    expect(springBoot.strength).toBe('contested');
    expect(springBoot.sourceStatement).toContain('Trillium GA');

    const javascript = findEntry(result.policy, 'javascript');
    const typescript = findEntry(result.policy, 'typescript');
    expect(javascript.constraint).toBeUndefined();
    expect(typescript.constraint).toBeUndefined();

    const react = findEntry(result.policy, 'react');
    expect(react.sourceStatement).toBe('React ^18.2.0');
    expect(react.constraint).toEqual({ kind: 'range', expression: '^18.2.0' });

    const rmb = findEntry(result.policy, 'raml-module-builder');
    expect(rmb.applicability).toContain('existing-modules');
    expect(rmb.deprecation?.deprecated).toBe(true);

    expect(normalizeS007PolicyVersionExpression('35')).toBe('>=35.0.0 <36.0.0-0');
    expect(normalizeS007PolicyVersionExpression('7')).toBe('>=7.0.0 <8.0.0-0');
    expect(normalizeS007PolicyVersionExpression('26.x')).toBe('>=26.0.0 <27.0.0-0');
  });

  it('preserves optional historical metadata without requiring it', async () => {
    const committed = await readCommittedPolicy();
    expect(committed.source?.url).toContain('Officially+Supported+Technologies');
    expect(committed.source?.documentStatus).toBe('ACCEPTED');
    expect(committed.source?.exportDate).toBe('2026-07-14');
    expect(committed.source?.reviewDate).toBe('2026-01-26');
    expect(committed.source?.supportPeriod?.endDate).toBe('2027-06-30');
    expect(committed.source?.notes?.join(' ')).toContain('Sunflower');

    delete committed.source;
    const result = await loadFixture(committed);

    expect(result.ok).toBe(true);
  });

  it('returns a missing-policy diagnostic', async () => {
    const result = await loadS007Policy(path.join(fixtureDir, 'missing.json'));

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'policy_missing' })]
    });
  });

  it('returns a parse diagnostic for malformed JSON', async () => {
    const policyPath = path.join(fixtureDir, 'policy.json');
    await fs.writeFile(policyPath, '{ not json');

    const result = await loadS007Policy(policyPath);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'policy_parse_error' })]
    });
  });

  it.each([
    ['unsupported format version', (policy: Record<string, any>) => { policy.formatVersion = '2.0'; }],
    ['missing required category', (policy: Record<string, any>) => {
      policy.sections = policy.sections.filter((section: { id: string }) => section.id !== 'infrastructure');
    }],
    ['invalid normative provisional combination', (policy: Record<string, any>) => {
      const entry = policy.sections[0].entries[0];
      entry.strength = 'normative';
      entry.provisional = true;
    }]
  ])('rejects %s', async (_name, mutate) => {
    const policy = await readCommittedPolicy();
    mutate(policy);

    const result = await loadFixture(policy);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected policy validation to fail');
    }
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'policy_schema_error')).toBe(true);
  });

  async function loadFixture(policy: unknown) {
    const policyPath = path.join(fixtureDir, 'policy.json');
    await fs.writeJson(policyPath, policy);
    return loadS007Policy(policyPath);
  }
});

async function readCommittedPolicy(): Promise<Record<string, any>> {
  return fs.readJson(DEFAULT_S007_POLICY_PATH);
}

function findEntry(policy: { sections: Array<{ entries: Array<{ id: string }> }> }, id: string): any {
  const entry = policy.sections.flatMap(section => section.entries).find(candidate => candidate.id === id);
  if (!entry) {
    throw new Error(`Missing policy entry: ${id}`);
  }
  return entry;
}
