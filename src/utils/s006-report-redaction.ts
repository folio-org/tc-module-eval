import { redactLocalUserPaths, redactSensitiveText } from './redaction';

export function redactS006Path(path: string): string {
  return redactLocalUserPaths(redactS006ReportText(path));
}

export function redactS006ReportText(input: string, maxBytes?: number): string {
  return redactLocalUserPaths(redactSensitiveText(input, maxBytes));
}
