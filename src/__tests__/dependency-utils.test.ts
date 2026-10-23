/**
 * Tests for dependency analysis utilities
 */

import { getDependencies } from '../utils/dependency-orchestrator';
import { checkLicenseCompliance } from '../utils/license-compliance';
import { LicenseCategory } from '../utils/license-policy';
import { Dependency, ComplianceResult, LicenseIssueType } from '../types';
import { setLogger, resetLogger, NoopLogger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs and child_process for testing
jest.mock('fs');
jest.mock('child_process');

const mockFs = fs as jest.Mocked<typeof fs>;

// Mock the license configuration loading
jest.mock('../utils/license-policy', () => {
  const actual = jest.requireActual('../utils/license-policy');
  return {
    ...actual,
    // Provide test configuration data
    getLicenseCategoryNormalized: jest.fn((licenseName: string) => {
      const testCategories: Record<string, string> = {
        'Apache-2.0': 'A',
        'MIT': 'A',
        'BSD-2-Clause': 'A',
        'LGPL-2.1': 'X',
        'MPL-2.0': 'B',
        'Mozilla Public License 2.0': 'B',
        'EPL-2.0': 'B',
        'Eclipse Public License 1.0': 'B',
        'Eclipse Public License 2.0': 'B',
        'CDDL-1.0': 'B',
        'Common Development and Distribution License 1.0': 'B',
        'GPL-3.0': 'X'
      };
      return testCategories[licenseName];
    }),
    isSpecialException: jest.fn((dependencyName: string) => {
      return dependencyName === 'org.hibernate:hibernate-core' ||
             dependencyName === 'org.z3950.zing:cql-java' ||
             dependencyName.startsWith('org.hibernate');
    })
  };
});

describe('Dependency Utils', () => {

  beforeEach(() => {
    setLogger(new NoopLogger());
  });

  afterEach(() => {
    resetLogger();
  });

  describe('checkLicenseCompliance', () => {
    
    it('should pass with only Category A licenses', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.apache.commons:commons-lang3',
          version: '3.12.0',
          licenses: ['Apache-2.0']
        },
        {
          name: 'junit:junit',
          version: '4.13.2',
          licenses: ['MIT']
        }
      ];
      
      const readmeContent = 'This is a test README';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should fail with Category X licenses', () => {
      const dependencies: Dependency[] = [
        {
          name: 'some.gpl:library',
          version: '1.0.0',
          licenses: ['GPL-3.0']
        }
      ];
      
      const readmeContent = 'This is a test README';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('is prohibited (Category X)');
    });

    it('should fail with undocumented Category B licenses', () => {
      const dependencies: Dependency[] = [
        {
          name: 'some.mpl:library',
          version: '1.0.0',
          licenses: ['MPL-2.0']
        }
      ];
      
      const readmeContent = 'This is a test README without any license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('the README does not name this dependency');
    });

    it('should pass when the README names the Category B dependency', () => {
      const dependencies: Dependency[] = [
        {
          name: 'some.mpl:library',
          version: '1.0.0',
          licenses: ['MPL-2.0']
        }
      ];

      const readmeContent = 'Third-party notices: some.mpl:library is used under the MPL-2.0.';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    // LGPL-2.1 is Category X; the listed special exceptions may still use it if the README names them.
    it.each([
      ['Hibernate libraries', 'org.hibernate:hibernate-core', 'hibernate-core'],
      ['the CQL Java library', 'org.z3950.zing:cql-java', 'cql-java']
    ])('should allow LGPL-2.1 for %s only when the README names the library', (_label, name, artifactId) => {
      const dependency: Dependency = { name, version: '1.0.0', licenses: ['LGPL-2.1'] };

      expect(checkLicenseCompliance([dependency], `Third-party notices: ${artifactId} is used under the LGPL-2.1.`))
        .toEqual({ compliant: true, issues: [] });
      expect(checkLicenseCompliance([dependency], 'This README does not mention any license information')).toEqual({
        compliant: false,
        issues: [{
          dependency,
          reason: "'LGPL-2.1' is allowed for this library only if the README names it, and it does not.",
          issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B
        }]
      });
    });

    it('should reject LGPL-2.1 for a library that is not a special exception, even when the README names it', () => {
      const result = checkLicenseCompliance(
        [{ name: 'some.lgpl:library', version: '1.0.0', licenses: ['LGPL-2.1'] }],
        'Third-party notices: some.lgpl:library is used under the LGPL-2.1.'
      );

      expect(result.compliant).toBe(false);
      expect(result.issues.map(issue => [issue.reason, issue.issueType])).toEqual([
        ["'LGPL-2.1' is prohibited (Category X).", LicenseIssueType.CATEGORY_X_VIOLATION]
      ]);
    });

    // Comprehensive Category B license tests
    describe('Category B License Documentation Tests', () => {
      const categoryBDependencies: Dependency[] = [
        { name: 'org.mozilla:rhino', version: '1.7.14', licenses: ['MPL-2.0'] },
        { name: 'org.eclipse.angus:angus-activation', version: '2.0.3', licenses: ['EPL-2.0'] },
        { name: 'javax.mail:mail', version: '1.4.7', licenses: ['CDDL-1.0'] }
      ];

      it('should not accept a license family keyword as a README mention of the dependency', () => {
        // Each line used to count: "eclipse"/"epl" (also inside "deployment"), "mozilla"/"mpl" (inside "example"),
        // and "common development". None of them names a dependency.
        const readmeContent = [
          'This project uses Mozilla Public License, Eclipse Public License and',
          'Common Development and Distribution License libraries.',
          'See the deployment example for details.'
        ].join('\n');
        const result = checkLicenseCompliance(categoryBDependencies, readmeContent);

        expect(result.compliant).toBe(false);
        expect(result.issues.map(issue => issue.dependency.name)).toEqual(categoryBDependencies.map(dep => dep.name));
        expect(result.issues.every(issue => issue.issueType === LicenseIssueType.UNDOCUMENTED_CATEGORY_B)).toBe(true);
      });

      it('should accept a README that names the dependency by artifactId or full name, in any case', () => {
        const readmeContent = [
          '## Third-party licenses',
          '- Rhino (MPL-2.0)',
          '- angus-activation, under the EPL-2.0',
          '- javax.mail:mail (CDDL-1.0)'
        ].join('\n');
        const result = checkLicenseCompliance(categoryBDependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should not count a longer name that only contains the artifactId', () => {
        const dependencies: Dependency[] = [{ name: 'org.mozilla:rhino', version: '1.7.14', licenses: ['MPL-2.0'] }];
        const result = checkLicenseCompliance(dependencies, 'Uses rhino-engine, myrhino and rhino.engine.');

        expect(result.compliant).toBe(false);
        expect(result.issues).toHaveLength(1);
      });

      it('should accept a name at the end of a sentence', () => {
        const dependencies: Dependency[] = [{ name: 'org.mozilla:rhino', version: '1.7.14', licenses: ['MPL-2.0'] }];
        expect(checkLicenseCompliance(dependencies, 'This module bundles rhino.').compliant).toBe(true);
      });

      it('should fail with undocumented Category B dependencies', () => {
        const result = checkLicenseCompliance(categoryBDependencies, 'This README does not document any third-party license information.');

        expect(result.compliant).toBe(false);
        expect(result.issues).toHaveLength(3);
        expect(result.issues[0].reason).toContain('the README does not name this dependency');
      });
    });

    it('should report issues for dependencies without license information', () => {
      const dependencies: Dependency[] = [
        {
          name: 'unknown:library',
          version: '1.0.0',
          licenses: undefined
        },
        {
          name: 'empty:library',
          version: '1.0.0',
          licenses: []
        }
      ];
      
      const readmeContent = 'This is a test README';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].reason).toBe('No license was reported.');
      expect(result.issues[1].reason).toBe('No license was reported.');
    });

    it('should report issues for unknown licenses', () => {
      const dependencies: Dependency[] = [
        {
          name: 'custom:library',
          version: '1.0.0',
          licenses: ['Custom-License-1.0']
        }
      ];
      
      const readmeContent = 'This is a test README';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toBe("'Custom-License-1.0' is not in the evaluator's list of known licenses.");
    });

  });

  describe('getDependencies', () => {

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should return empty dependencies with warning when no build files found', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const result = await getDependencies('/fake/path');

      expect(result.dependencies).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0].message).toContain('does not exist');
    });

    it('should return error when path validation fails', async () => {
      mockFs.existsSync.mockImplementation(() => {
        throw new Error('File system error');
      });

      const result = await getDependencies('/fake/path');

      expect(result.dependencies).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].source).toBe('dependency-orchestrator');
    });

  });

  describe('Dual License Handling', () => {
    // A dependency passes without README documentation when any of its licenses is Category A,
    // whatever the other licenses are (Category X, B, unknown) and wherever the Category A license appears.
    it.each([
      ['Category A + Category A', 'org.example:dual-lib', ['Apache-2.0', 'MIT']],
      ['Category A + Category X', 'org.example:mixed-lib', ['Apache-2.0', 'GPL-3.0']],
      ['Category A + unknown', 'org.example:unknown-mix', ['Apache-2.0', 'SomeUnknownLicense']],
      ['triple Category A', 'org.example:triple-lib', ['Apache-2.0', 'MIT', 'BSD-3-Clause']],
      ['Category A + Category B', 'org.example:a-b-mix', ['Apache-2.0', 'MPL-2.0']],
      ['Category B + Category A', 'org.example:previously-configured-dual', ['MPL-2.0', 'Apache-2.0']]
    ])('should pass an undocumented dependency licensed %s', (_case, name, licenses) => {
      const dependencies: Dependency[] = [{ name, version: '1.0.0', licenses }];

      const result = checkLicenseCompliance(dependencies, 'No license documentation');

      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should pass when dual-licensed Category B with one documented (MPL-2.0|EPL-2.0)', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:dual-b-lib',
          version: '1.0.0',
          licenses: ['MPL-2.0', 'EPL-2.0']
        }
      ];

      const readmeContent = 'This project bundles dual-b-lib under the MPL-2.0.';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // ANY Category B documented = pass
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should fail when dual-licensed Category B|X with neither documented', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:b-x-lib',
          version: '1.0.0',
          licenses: ['MPL-2.0', 'GPL-3.0']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Neither MPL (requires docs) nor GPL (prohibited) passes
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
    });

    it('should handle multiple dual-licensed dependencies correctly', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:dual-a',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'MIT']
        },
        {
          name: 'org.example:dual-b',
          version: '1.0.0',
          licenses: ['MPL-2.0', 'Apache-2.0']
        },
        {
          name: 'org.example:dual-x',
          version: '1.0.0',
          licenses: ['GPL-3.0', 'LGPL-2.1']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // First two should pass (have Category A), third should fail (both Category X)
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].dependency.name).toBe('org.example:dual-x');
    });

    it.each([
      ['pipe separator', 'org.example:unsplit-licenses', 'Apache-2.0|MIT'], // Parser failed to split!
      ['OR separator', 'org.example:npm-style-unsplit', 'MIT OR Apache-2.0'], // npm/SPDX format - parser should split!
      ['AND separator', 'org.example:spdx-and-unsplit', 'LGPL-2.1 AND MIT'], // SPDX format - parser should split!
      ['parentheses', 'org.example:complex-unsplit', '(MIT OR Apache-2.0)'], // Complex SPDX expression - parser should split!
      ['WITH keyword', 'org.example:spdx-exception-unsplit', 'Apache-2.0 WITH LLVM-exception'] // SPDX exception - parser should normalize!
    ])('should detect parser contract violation when licenses contain %s', (_name, name, license) => {
      const dependencies: Dependency[] = [{ name, version: '1.0.0', licenses: [license] }];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Should fail due to parser contract violation
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('combines several licenses and could not be checked');
      expect(result.issues[0].reason).toContain(`'${license}'`);
    });
  });

});
