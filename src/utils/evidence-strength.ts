export type EvidenceStrength = 'strong' | 'candidate' | 'context' | 'insufficient';

export function evidenceStrengthRank(strength: EvidenceStrength): number {
  switch (strength) {
    case 'strong': return 0;
    case 'candidate': return 1;
    case 'context': return 2;
    case 'insufficient': return 3;
  }
}
