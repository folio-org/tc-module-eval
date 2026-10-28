import {
  getCriteriaForLanguage,
  ADMINISTRATIVE_CRITERIA,
  SHARED_CRITERIA,
  BACKEND_CRITERIA,
  FRONTEND_CRITERIA,
  getAcceptanceCriterionDefinition,
  getCriteriaForSection,
  createDefaultCriterionResult
} from '../criteria-definitions';
import { EvaluationStatus } from '../types';

describe('criteria-definitions', () => {
  describe('getCriteriaForLanguage', () => {
    it.each(['java', 'JAVA'])('should return Java criteria for %s', language => {
      const result = getCriteriaForLanguage(language);
      expect(result).toEqual([...ADMINISTRATIVE_CRITERIA, ...SHARED_CRITERIA, ...BACKEND_CRITERIA]);
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

    it('should expose extended catalog metadata alongside the basic definition fields', () => {
      const catalogEntry = getAcceptanceCriterionDefinition('S002');
      expect(catalogEntry?.languages).toEqual(['java', 'javascript']);
      expect(catalogEntry?.defaultEvaluation?.reason).toBe('Module descriptor validation');
      expect(getAcceptanceCriterionDefinition('S005')?.defaultEvaluation?.reason).toBe('Personal data disclosure form evaluation');
      expect(getAcceptanceCriterionDefinition('S006')?.defaultEvaluation?.reason).toBe('Sensitive information repository scan');

      expect(catalogEntry).toMatchObject({
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
