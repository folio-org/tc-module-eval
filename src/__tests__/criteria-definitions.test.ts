import {
  getCriteriaForLanguage,
  JAVA_CRITERIA,
  ADMINISTRATIVE_CRITERIA,
  SHARED_CRITERIA,
  FRONTEND_CRITERIA,
  isValidCriterionId,
  getSectionForCriterion,
  getDescriptionForCriterion,
  getCriterionDefinition,
  getAcceptanceCriterionDefinition,
  getCriteriaForSection,
  createDefaultCriterionResult
} from '../criteria-definitions';
import { EvaluationStatus } from '../types';

describe('criteria-definitions', () => {
  describe('getCriteriaForLanguage', () => {
    it('should return Java criteria for java language', () => {
      const result = getCriteriaForLanguage('java');
      expect(result).toEqual(JAVA_CRITERIA);
      expect(result).toContain('A001');
      expect(result).toContain('S001');
      expect(result).toContain('B001');
    });

    it('should return Java criteria for JAVA (uppercase)', () => {
      const result = getCriteriaForLanguage('JAVA');
      expect(result).toEqual(JAVA_CRITERIA);
    });

    it('should return frontend criteria for javascript', () => {
      const result = getCriteriaForLanguage('javascript');
      expect(result).toEqual([...ADMINISTRATIVE_CRITERIA, ...SHARED_CRITERIA, ...FRONTEND_CRITERIA]);
      expect(result).toContain('A001');
      expect(result).toContain('S001');
      expect(result).toContain('F001');
    });

    it('should return frontend criteria for typescript', () => {
      const result = getCriteriaForLanguage('typescript');
      expect(result).toEqual([...ADMINISTRATIVE_CRITERIA, ...SHARED_CRITERIA, ...FRONTEND_CRITERIA]);
    });

    it('should return frontend criteria for react', () => {
      const result = getCriteriaForLanguage('react');
      expect(result).toEqual([...ADMINISTRATIVE_CRITERIA, ...SHARED_CRITERIA, ...FRONTEND_CRITERIA]);
    });

    it('should return frontend criteria for React (uppercase)', () => {
      const result = getCriteriaForLanguage('React');
      expect(result).toEqual([...ADMINISTRATIVE_CRITERIA, ...SHARED_CRITERIA, ...FRONTEND_CRITERIA]);
    });

    it('should throw error for unknown language', () => {
      expect(() => getCriteriaForLanguage('python')).toThrow(
        'Unsupported language: python. Supported languages are: java, javascript, typescript, react'
      );
    });

    it('should throw error for empty language', () => {
      expect(() => getCriteriaForLanguage('')).toThrow(
        'Unsupported language: . Supported languages are: java, javascript, typescript, react'
      );
    });

    it('should throw error for go language', () => {
      expect(() => getCriteriaForLanguage('go')).toThrow(
        'Unsupported language: go. Supported languages are: java, javascript, typescript, react'
      );
    });

    it('should throw error for ruby language', () => {
      expect(() => getCriteriaForLanguage('ruby')).toThrow(
        'Unsupported language: ruby. Supported languages are: java, javascript, typescript, react'
      );
    });
  });

  describe('isValidCriterionId', () => {
    it('should return true for valid administrative criterion', () => {
      expect(isValidCriterionId('A001')).toBe(true);
    });

    it('should return true for valid shared criterion', () => {
      expect(isValidCriterionId('S001')).toBe(true);
      expect(isValidCriterionId('S014')).toBe(true);
    });

    it('should return true for valid backend criterion', () => {
      expect(isValidCriterionId('B001')).toBe(true);
      expect(isValidCriterionId('B016')).toBe(true);
    });

    it('should return true for valid frontend criterion', () => {
      expect(isValidCriterionId('F001')).toBe(true);
      expect(isValidCriterionId('F007')).toBe(true);
    });

    it('should return false for invalid criterion', () => {
      expect(isValidCriterionId('X001')).toBe(false);
      expect(isValidCriterionId('S999')).toBe(false);
      expect(isValidCriterionId('invalid')).toBe(false);
      expect(isValidCriterionId('')).toBe(false);
    });
  });

  describe('getSectionForCriterion', () => {
    it('should return correct section for administrative criterion', () => {
      expect(getSectionForCriterion('A001')).toBe('Administrative');
    });

    it('should return correct section for shared criterion', () => {
      expect(getSectionForCriterion('S001')).toBe('Shared/Common');
    });

    it('should return correct section for backend criterion', () => {
      expect(getSectionForCriterion('B001')).toBe('Backend');
    });

    it('should return correct section for frontend criterion', () => {
      expect(getSectionForCriterion('F001')).toBe('Frontend');
    });

    it('should return Unknown for invalid criterion', () => {
      expect(getSectionForCriterion('X001')).toBe('Unknown');
    });
  });

  describe('getDescriptionForCriterion', () => {
    it('should return correct description for administrative criterion', () => {
      expect(getDescriptionForCriterion('A001')).toBe(
        'Listed by Product Council with positive evaluation result'
      );
    });

    it('should return correct description for shared criterion', () => {
      expect(getDescriptionForCriterion('S001')).toBe('Uses Apache 2.0 license');
    });

    it('should return correct description for backend criterion', () => {
      expect(getDescriptionForCriterion('B001')).toBe('Compliant Module Descriptor');
    });

    it('should return correct description for frontend criterion', () => {
      expect(getDescriptionForCriterion('F001')).toBe(
        'API interface requirements in package.json'
      );
    });

    it('should return Unknown criterion for invalid ID', () => {
      expect(getDescriptionForCriterion('X001')).toBe('Unknown criterion');
    });
  });

  describe('getCriterionDefinition', () => {
    it('should return complete definition for valid criterion', () => {
      const definition = getCriterionDefinition('S001');
      expect(definition).toEqual({
        id: 'S001',
        description: 'Uses Apache 2.0 license',
        section: 'Shared/Common'
      });
    });

    it('should return undefined for invalid criterion', () => {
      expect(getCriterionDefinition('X001')).toBeUndefined();
    });
  });

  describe('acceptance criterion catalog', () => {
    it('should expose canonical criteria by section and language', () => {
      expect(getCriteriaForSection('Shared/Common', 'java')).toEqual(SHARED_CRITERIA);
      expect(getCriteriaForSection('Shared/Common', 'javascript')).toEqual(SHARED_CRITERIA);
      expect(getCriteriaForSection('Backend', 'java')).toEqual([
        'B001', 'B002', 'B003', 'B004', 'B005', 'B006', 'B007', 'B008',
        'B009', 'B010', 'B011', 'B012', 'B013', 'B014', 'B015', 'B016'
      ]);
      expect(getCriteriaForSection('Frontend', 'javascript')).toEqual(FRONTEND_CRITERIA);
      expect(getCriteriaForSection('Frontend', 'java')).toEqual([]);
    });

    it('should expose extended catalog metadata without changing basic definitions', () => {
      const catalogEntry = getAcceptanceCriterionDefinition('S002');
      expect(catalogEntry?.languages).toEqual(['java', 'javascript']);
      expect(catalogEntry?.defaultEvaluation?.reason).toBe('Module descriptor validation');
      expect(getAcceptanceCriterionDefinition('S005')?.defaultEvaluation?.reason).toBe('Personal data disclosure form evaluation');

      expect(getCriterionDefinition('S002')).toEqual({
        id: 'S002',
        description: 'Module build produces valid module descriptor',
        section: 'Shared/Common'
      });
    });

    it('should create default Java not-implemented results from the catalog', () => {
      const result = createDefaultCriterionResult('S002', 'java');

      expect(result).toEqual({
        criterionId: 'S002',
        status: EvaluationStatus.MANUAL,
        evidence: 'Module descriptor validation - evaluation logic not yet implemented',
        details: 'This criterion requires manual evaluation by a human reviewer'
      });
    });

    it('should create manual-review fallback results from the catalog', () => {
      const result = createDefaultCriterionResult('A001', 'java');

      expect(result).toEqual({
        criterionId: 'A001',
        status: EvaluationStatus.MANUAL,
        evidence: 'Product Council approval verification requires manual review',
        details: 'This criterion requires manual evaluation by a human reviewer'
      });
    });

    it('should create JavaScript-specific fallback wording from the catalog', () => {
      const result = createDefaultCriterionResult('S002', 'javascript');

      expect(result.status).toBe(EvaluationStatus.MANUAL);
      expect(result.evidence).toBe('package.json and stripes metadata validation - evaluation logic not yet implemented');
    });
  });
});
