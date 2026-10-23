/**
 * Tests for license name normalization functionality
 */

import { normalizeLicenseName, getLicenseCategoryNormalized, LicenseCategory } from '../utils/license-policy';
import { checkLicenseCompliance } from '../utils/license-compliance';
import { LicenseIssueType } from '../types';

describe('License Name Normalization', () => {
  describe('normalizeLicenseName', () => {
    // Test parenthetical extraction (Maven format)
    test.each([
      ['(The Apache Software License, Version 2.0) jackson-databind', 'The Apache Software License, Version 2.0'],
      ['(Apache-2.0) Apache Commons IO', 'Apache-2.0'],
      ['(The MIT License) Project Lombok', 'MIT License'],
      ['(BSD-2-Clause) PostgreSQL JDBC Driver', 'BSD-2-Clause']
    ])('should extract license from parenthetical format (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test artifact information removal
    test.each([
      ['(The Apache Software License, Version 2.0) jackson-databind (com.fasterxml.jackson.core', 'The Apache Software License, Version 2.0'],
      ['(Apache License, Version 2.0) folio-spring-base (org.folio', 'Apache License 2.0'],
      ['Apache License 2.0 - https://www.apache.org/licenses', 'Apache License 2.0']
    ])('should remove trailing artifact information (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test Apache variations from real FOLIO data
    test.each([
      ['Apache 2', 'Apache-2.0'],
      ['Apache License, Version 2.0', 'Apache License 2.0'],
      ['Apache 2.0', 'Apache-2.0'],
      ['Apache License Version 2.0', 'Apache License 2.0'],
      ['The Apache Software License, Version 2.0', 'The Apache Software License, Version 2.0'],
      ['Apache Public License 2.0', 'Apache-2.0']
    ])('should normalize Apache license variations (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test MIT variations from real FOLIO data
    test.each([
      ['MIT', 'MIT'],
      ['MIT License', 'MIT License'],
      ['MIT-0', 'MIT'],
      ['The MIT License', 'MIT License']
    ])('should normalize MIT license variations (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test BSD variations from real FOLIO data
    test.each([
      ['3-Clause BSD License', 'BSD-3-Clause'],
      ['BSD', 'BSD-3-Clause'],
      ['BSD 2-Clause License', 'BSD-2-Clause'],
      ['BSD License', 'BSD-3-Clause'],
      ['BSD-2-Clause', 'BSD-2-Clause'],
      ['The 2-Clause BSD License', 'BSD-2-Clause'],
      ['New BSD License', 'BSD-3-Clause']
    ])('should normalize BSD license variations (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test LGPL variations from real FOLIO data
    test.each([
      ['GNU Lesser General Public License, Version 2.1', 'GNU Lesser General Public License v2.1'],
      ['GNU LESSER GENERAL PUBLIC LICENSE, Version 2.1', 'GNU Lesser General Public License v2.1'],
      ['GNU Library General Public License v2.1 or later', 'GNU Lesser General Public License v2.1'],
      ['LGPL', 'LGPL-2.1']
    ])('should normalize LGPL license variations (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test Eclipse Public License variations from real FOLIO data
    test.each([
      ['Eclipse Public License v2.0', 'EPL-2.0'],
      ['Eclipse Public License - v 2.0', 'EPL-2.0'],
      ['(Eclipse Public License - v 1.0) AspectJ (org.aspectj:aspectjweaver:1.9.25.1 - https://example.org)', 'EPL-1.0'],
      ['Eclipse Public License 1.0', 'EPL-1.0'],
      ['Eclipse Public License, Version 2.0', 'Eclipse Public License 2.0'],
      ['EPL', 'EPL-1.0']
    ])('should normalize Eclipse license variations (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test other real FOLIO license variations
    test.each([
      ['Universal Permissive License, Version 1.0', 'Universal Permissive License, Version 1.0'],
      ['CC0', 'CC0-1.0'],
      ['Public Domain, per Creative Commons CC0', 'Public Domain'],
      ['Mozilla Public License, Version 2.0', 'Mozilla Public License 2.0'],
      ['MPL 2.0', 'MPL-2.0'],
      ['ISC', 'ISC'],
      ['Go License', 'BSD-3-Clause']
    ])('should normalize other common license variations (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test preservation of exact matches
    test.each([
      ['Apache-2.0', 'Apache-2.0'],
      ['MIT', 'MIT'],
      ['BSD-3-Clause', 'BSD-3-Clause'],
      ['LGPL-2.1', 'LGPL-2.1']
    ])('should preserve exact matches from license policy (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test unknown licenses
    test.each([
      ['Some Unknown License', 'Some Unknown License'],
      ['(Custom License) some-artifact', 'Custom License']
    ])('should return cleaned name for unknown licenses (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });

    // Test edge cases
    test.each([
      ['', ''],
      ['   ', ''],
      ['()', ''],
      ['(   )', '']
    ])('should handle edge cases (%p)', (license, expected) => {
      expect(normalizeLicenseName(license)).toBe(expected);
    });
  });

  describe('getLicenseCategoryNormalized', () => {
    // Test mod-search license strings from the actual report
    test.each([
      // Apache 2.0 variations from mod-search
      ['(The Apache Software License, Version 2.0) jackson-databind (com.fasterxml.jackson.core', LicenseCategory.A],
      ['(Apache-2.0) Apache Commons IO (commons-io', LicenseCategory.A],
      ['(Apache License, Version 2.0) folio-spring-base (org.folio', LicenseCategory.A],
      ['(Apache License 2.0) folio-service-tools-spring-dev (org.folio', LicenseCategory.A],
      // MIT License from mod-search
      ['(The MIT License) Project Lombok (org.projectlombok', LicenseCategory.A],
      // BSD License from mod-search
      ['(BSD-2-Clause) PostgreSQL JDBC Driver (org.postgresql', LicenseCategory.A],
      // LGPL License from mod-search (should be Category X)
      ['(GNU Lesser General Public License, Version 2.1) MARC4J (org.marc4j', LicenseCategory.X]
    ])('should categorize mod-search license strings correctly (%p)', (license, expected) => {
      expect(getLicenseCategoryNormalized(license)).toBe(expected);
    });

    // Test exact matches still work
    test.each([
      ['Apache-2.0', LicenseCategory.A],
      ['MIT', LicenseCategory.A],
      ['BSD-2-Clause', LicenseCategory.A],
      ['LGPL-2.1', LicenseCategory.X],
      ['GPL-2.0', LicenseCategory.X]
    ])('should handle exact matches from license policy (%p)', (license, expected) => {
      expect(getLicenseCategoryNormalized(license)).toBe(expected);
    });

    // Test unknown licenses
    test.each([
      'Some Unknown License',
      '(Proprietary License) some-artifact'
    ])('should return undefined for unknown licenses (%p)', license => {
      expect(getLicenseCategoryNormalized(license)).toBeUndefined();
    });

    // ASF lists GPL-2.0 with the Classpath exception under Category B ("weak copyleft"); its Category X
    // GPL entry excludes it. The bare GPL-2.0 stays Category X.
    test.each([
      'GPL-2.0-only WITH Classpath-exception-2.0',
      'GPL-2.0 WITH Classpath-exception-2.0',
      'GNU General Public License, version 2 with the GNU Classpath Exception',
      'GNU General Public License, version 2, with the Classpath Exception',
      'GNU General Public License, Version 2 with the Classpath Exception',
      'GPL v2 with the Classpath exception',
      'GPL2 w/ CPE'
    ])('should put GPL-2.0 with the Classpath exception (%s) in Category B', license => {
      expect(getLicenseCategoryNormalized(normalizeLicenseName(license))).toBe(LicenseCategory.B_WCL);
    });

    // ASF lists the Eclipse Distribution License 1.0 under Category A, as a BSD-3-Clause variant.
    test.each([
      'Eclipse Distribution License - v 1.0',
      'Eclipse Distribution License v. 1.0',
      'Eclipse Distribution License v1.0',
      'Eclipse Distribution License',
      'EDL 1.0'
    ])('should put the Eclipse Distribution License (%s) in Category A', license => {
      expect(getLicenseCategoryNormalized(normalizeLicenseName(license))).toBe(LicenseCategory.A);
    });

    test('should check GPL-2.0 with the Classpath exception as one Category B license, not an unsplit expression', () => {
      const dependency = { name: 'org.openjdk.nashorn:nashorn-core', version: '15.4', licenses: [normalizeLicenseName('GPL v2 with the Classpath exception')] };

      const result = checkLicenseCompliance([dependency], 'This module uses nashorn-core.');
      const unnamed = checkLicenseCompliance([dependency], '');

      expect(result.issues).toEqual([]);
      expect(unnamed.issues).toEqual([expect.objectContaining({ issueType: LicenseIssueType.UNDOCUMENTED_CATEGORY_B })]);
    });

    test.each(['(MIT) AND (GPL-3.0)', '(MIT)|GPL-3.0'])('should still report %s as an unsplit expression', license => {
      // Normalizing either one would keep only "MIT" (Category A).
      const result = checkLicenseCompliance([{ name: 'org.example:lib', version: '1.0', licenses: [license] }], '');

      expect(result.issues).toEqual([expect.objectContaining({ issueType: LicenseIssueType.PARSER_ERROR })]);
    });

    // Test normalization fallback
    test.each([
      ['Apache License Version 2.0', LicenseCategory.A],
      ['MIT License', LicenseCategory.A],
      ['GNU Lesser General Public License, Version 2.1', LicenseCategory.X]
    ])('should fall back to normalization when exact match fails (%p)', (license, expected) => {
      expect(getLicenseCategoryNormalized(license)).toBe(expected);
    });
  });

  describe('Integration with real Maven output', () => {
    test('should handle complex Maven license strings', () => {
      // Simulate the problematic license strings from the mod-search report
      const problematicLicenses = [
        '(The Apache Software License, Version 2.0) jackson-databind (com.fasterxml.jackson.core',
        '(Apache-2.0) Apache Commons IO (commons-io',
        '(Apache License, Version 2.0) folio-spring-base (org.folio',
        '(The MIT License) Project Lombok (org.projectlombok',
        '(BSD-2-Clause) PostgreSQL JDBC Driver (org.postgresql',
        '(GNU Lesser General Public License, Version 2.1) MARC4J (org.marc4j'
      ];

      const expectedCategories = [
        LicenseCategory.A, // Apache variations
        LicenseCategory.A,
        LicenseCategory.A,
        LicenseCategory.A, // MIT
        LicenseCategory.A, // BSD
        LicenseCategory.X  // LGPL
      ];

      problematicLicenses.forEach((license, index) => {
        const category = getLicenseCategoryNormalized(license);
        expect(category).toBe(expectedCategories[index]);
      });
    });
  });
});