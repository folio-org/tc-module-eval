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
    it.each(['java', 'JAVA'])('should return Java criteria for %s', language => {
      const result = getCriteriaForLanguage(language);
      expect(result).toEqual(JAVA_CRITERIA);
      expect(result).toContain('A001');
      expect(result).toContain('S001');
      expect(result).toContain('B001');
    });

    it.each(['javascript', 'typescript', 'react', 'React'])('should return frontend criteria for %s', language => {
      const result = getCriteriaForLanguage(language);
      expect(result).toEqual([...ADMINISTRATIVE_CRITERIA, ...SHARED_CRITERIA, ...FRONTEND_CRITERIA]);
      expect(result).toContain('A001');
      expect(result).toContain('S001');
      expect(result).toContain('F001');
    });

    it.each([
      ['python', 'Unsupported language: python. Supported languages are: java, javascript, typescript, react'],
      ['', 'Unsupported language: . Supported languages are: java, javascript, typescript, react'],
      ['go', 'Unsupported language: go. Supported languages are: java, javascript, typescript, react'],
      ['ruby', 'Unsupported language: ruby. Supported languages are: java, javascript, typescript, react']
    ])('should throw error for unsupported language %p', (language, message) => {
      expect(() => getCriteriaForLanguage(language)).toThrow(message);
    });
  });

  describe('isValidCriterionId', () => {
    it.each(['A001', 'S001', 'S014', 'B001', 'B016', 'F001', 'F007'])('should return true for valid criterion %s', id => {
      expect(isValidCriterionId(id)).toBe(true);
    });

    it.each(['X001', 'S999', 'invalid', ''])('should return false for invalid criterion %p', id => {
      expect(isValidCriterionId(id)).toBe(false);
    });
  });

  describe('getSectionForCriterion', () => {
    it.each([
      ['A001', 'Administrative'],
      ['S001', 'Shared/Common'],
      ['B001', 'Backend'],
      ['F001', 'Frontend'],
      ['X001', 'Unknown']
    ])('should return the section for %s (%s)', (id, section) => {
      expect(getSectionForCriterion(id)).toBe(section);
    });
  });

  describe('getDescriptionForCriterion', () => {
    it.each([
      ['A001', 'Listed by Product Council with positive evaluation result'],
      ['S001', 'Uses Apache 2.0 license'],
      ['B001', 'Compliant Module Descriptor'],
      ['F001', 'API interface requirements in package.json'],
      ['X001', 'Unknown criterion']
    ])('should return the description for %s (%p)', (id, description) => {
      expect(getDescriptionForCriterion(id)).toBe(description);
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
      expect(getAcceptanceCriterionDefinition('S006')?.defaultEvaluation?.reason).toBe('Sensitive information repository scan');

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
