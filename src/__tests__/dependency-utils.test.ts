/**
 * Tests for dependency analysis utilities
 */

import { getDependencies } from '../utils/dependency-orchestrator';
import { checkLicenseCompliance } from '../utils/license-compliance';
import { LicenseCategory } from '../utils/license-policy';
import { Dependency, ComplianceResult } from '../types';
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
    getLicenseCategory: jest.fn((licenseName: string) => {
      const testCategories: Record<string, string> = {
        'Apache-2.0': 'A',
        'MIT': 'A',
        'BSD-2-Clause': 'A',
        'LGPL-2.1': 'B',
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
    getLicenseCategoryNormalized: jest.fn((licenseName: string) => {
      const testCategories: Record<string, string> = {
        'Apache-2.0': 'A',
        'MIT': 'A',
        'BSD-2-Clause': 'A',
        'LGPL-2.1': 'B',
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
    getLicensesInCategory: jest.fn((category: string) => {
      const categoryBLicenses = [
        'LGPL-2.1',
        'MPL-2.0',
        'Mozilla Public License 2.0',
        'EPL-2.0',
        'Eclipse Public License 1.0',
        'Eclipse Public License 2.0',
        'CDDL-1.0',
        'Common Development and Distribution License 1.0'
      ];

      if (category === 'B') {
        return categoryBLicenses;
      }
      return [];
    }),
    isSpecialException: jest.fn((dependencyName: string) => {
      return dependencyName === 'org.hibernate:hibernate-core' ||
             dependencyName === 'org.z3950.zing:cql-java' ||
             dependencyName.startsWith('org.hibernate');
    })
  };
});

describe('Dependency Utils', () => {

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
      expect(result.issues[0].reason).toContain('Category X (prohibited)');
    });

    it('should fail with undocumented Category B licenses', () => {
      const dependencies: Dependency[] = [
        {
          name: 'some.lgpl:library',
          version: '1.0.0',
          licenses: ['LGPL-2.1']
        }
      ];
      
      const readmeContent = 'This is a test README without any license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('not documented in README');
    });

    it('should pass with documented Category B licenses', () => {
      const dependencies: Dependency[] = [
        {
          name: 'some.lgpl:library',
          version: '1.0.0',
          licenses: ['LGPL-2.1']
        }
      ];
      
      const readmeContent = 'This project uses LGPL libraries that are properly documented.';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should handle special exceptions for Hibernate libraries', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.hibernate:hibernate-core',
          version: '5.6.0',
          licenses: ['LGPL-2.1']
        }
      ];
      
      const readmeContent = 'This README does not mention any license information';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('special exception: org.hibernate:hibernate-core');
    });

    it('should handle special exceptions for CQL Java library', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.z3950.zing:cql-java',
          version: '1.13',
          licenses: ['LGPL-2.1']
        }
      ];
      
      const readmeContent = 'This README does not mention any license information';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('special exception: org.z3950.zing:cql-java');
    });

    // Comprehensive Category B license tests
    describe('Category B License Documentation Tests', () => {
      it('should pass with documented MPL (Mozilla Public License) dependencies', () => {
        const dependencies: Dependency[] = [
          {
            name: 'org.mozilla:rhino',
            version: '1.7.14',
            licenses: ['MPL-2.0']
          }
        ];

        const readmeContent = 'This project uses Mozilla Public License libraries.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should pass with documented MPL using "mozilla" keyword', () => {
        const dependencies: Dependency[] = [
          {
            name: 'org.mozilla:rhino',
            version: '1.7.14',
            licenses: ['Mozilla Public License 2.0']
          }
        ];

        const readmeContent = 'This project includes mozilla libraries that are documented here.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should fail with undocumented MPL dependencies', () => {
        const dependencies: Dependency[] = [
          {
            name: 'com.example:test-library',
            version: '1.7.14',
            licenses: ['MPL-2.0']
          }
        ];

        const readmeContent = 'This README does not document any third-party license information.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].reason).toContain('not documented in README');
      });

      it('should pass with documented EPL (Eclipse Public License) dependencies', () => {
        const dependencies: Dependency[] = [
          {
            name: 'org.eclipse.jdt:core',
            version: '3.18.0',
            licenses: ['EPL-2.0']
          }
        ];

        const readmeContent = 'This project uses Eclipse Public License libraries.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should pass with documented EPL using "eclipse" keyword', () => {
        const dependencies: Dependency[] = [
          {
            name: 'org.eclipse.core:runtime',
            version: '3.20.0',
            licenses: ['Eclipse Public License 1.0']
          }
        ];

        const readmeContent = 'This project includes eclipse foundation libraries.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should fail with undocumented EPL dependencies', () => {
        const dependencies: Dependency[] = [
          {
            name: 'com.example:test-library',
            version: '3.18.0',
            licenses: ['EPL-2.0']
          }
        ];

        const readmeContent = 'This README does not document any third-party license information.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].reason).toContain('not documented in README');
      });

      it('should pass with documented CDDL (Common Development and Distribution License) dependencies', () => {
        const dependencies: Dependency[] = [
          {
            name: 'javax.activation:activation',
            version: '1.1.1',
            licenses: ['CDDL-1.0']
          }
        ];

        const readmeContent = 'This project uses CDDL licensed libraries.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should pass with documented CDDL using full license name', () => {
        const dependencies: Dependency[] = [
          {
            name: 'javax.mail:mail',
            version: '1.4.7',
            licenses: ['Common Development and Distribution License 1.0']
          }
        ];

        const readmeContent = 'This project includes Common Development and Distribution License libraries.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it('should fail with undocumented CDDL dependencies', () => {
        const dependencies: Dependency[] = [
          {
            name: 'com.example:test-library',
            version: '1.1.1',
            licenses: ['CDDL-1.0']
          }
        ];

        const readmeContent = 'This README does not document any third-party license information.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].reason).toContain('not documented in README');
      });

      it('should handle mixed Category B dependencies', () => {
        const dependencies: Dependency[] = [
          {
            name: 'org.lgpl:library',
            version: '1.0.0',
            licenses: ['LGPL-2.1']
          },
          {
            name: 'org.mozilla:rhino',
            version: '1.7.14',
            licenses: ['MPL-2.0']
          },
          {
            name: 'org.eclipse:core',
            version: '3.18.0',
            licenses: ['EPL-2.0']
          }
        ];

        const readmeContent = 'This project uses LGPL, Mozilla, and Eclipse libraries that are documented here.';
        const result = checkLicenseCompliance(dependencies, readmeContent);

        expect(result.compliant).toBe(true);
        expect(result.issues).toHaveLength(0);
      });
    });

    it('should handle dependencies with multiple licenses', () => {
      const dependencies: Dependency[] = [
        {
          name: 'dual.licensed:library',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'MIT']
        }
      ];
      
      const readmeContent = 'This is a test README';
      const result = checkLicenseCompliance(dependencies, readmeContent);
      
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
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
      expect(result.issues[0].reason).toContain('No license information available');
      expect(result.issues[1].reason).toContain('No license information available');
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
      expect(result.issues[0].reason).toContain('Unknown license \'Custom-License-1.0\'');
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
    it('should pass when dual-licensed with Category A (Apache-2.0|MIT)', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:dual-lib',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'MIT']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should pass when dual-licensed Category A + Category X (Apache-2.0|GPL-3.0)', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:mixed-lib',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'GPL-3.0']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Category A wins over Category X
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

      const readmeContent = 'This project uses MPL licensed libraries.';
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

    it('should pass when dual-licensed with unknown but has Category A (Apache-2.0|SomeUnknownLicense)', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:unknown-mix',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'SomeUnknownLicense']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Known Category A license wins over unknown
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
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

    it('should handle triple-licensed dependencies (Apache-2.0|MIT|BSD-3-Clause)', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:triple-lib',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'MIT', 'BSD-3-Clause']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // All are Category A
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should split dual licenses from Maven THIRD-PARTY.txt format', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:maven-dual',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'MIT'] // Already split by parseMavenThirdPartyLine
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should handle Category A + Category B dual license without requiring documentation', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:a-b-mix',
          version: '1.0.0',
          licenses: ['Apache-2.0', 'MPL-2.0']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Category A wins, no documentation required
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should evaluate (MPL-2.0|Apache-2.0) with OR logic - previously managed by config entry', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:previously-configured-dual',
          version: '1.0.0',
          licenses: ['MPL-2.0', 'Apache-2.0']
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Apache-2.0 is Category A, so it should pass without documentation
      expect(result.compliant).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should detect parser contract violation when licenses contain pipe separator', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:unsplit-licenses',
          version: '1.0.0',
          licenses: ['Apache-2.0|MIT'] // Parser failed to split!
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Should fail due to parser contract violation
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('Parser error');
      expect(result.issues[0].reason).toContain('not properly split');
    });

    it('should detect parser contract violation when licenses contain OR separator', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:npm-style-unsplit',
          version: '1.0.0',
          licenses: ['MIT OR Apache-2.0'] // npm/SPDX format - parser should split!
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Should fail due to parser contract violation
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('Parser error');
      expect(result.issues[0].reason).toContain('separators');
    });

    it('should detect parser contract violation when licenses contain AND separator', () => {
      const dependencies: Dependency[] = [
        {
          name: 'org.example:spdx-and-unsplit',
          version: '1.0.0',
          licenses: ['LGPL-2.1 AND MIT'] // SPDX format - parser should split!
        }
      ];

      const readmeContent = 'No license documentation';
      const result = checkLicenseCompliance(dependencies, readmeContent);

      // Should fail due to parser contract violation
      expect(result.compliant).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].reason).toContain('Parser error');
    });
  });

});
