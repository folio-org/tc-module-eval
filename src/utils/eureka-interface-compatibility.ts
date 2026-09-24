import { S008RawProvidedInterface } from '../types';

export const EUREKA_INCOMPARABLE = 0x7fffffff;

export function compareEurekaInterfaces(
  provider: Pick<S008RawProvidedInterface, 'id' | 'version'>,
  requirement: Pick<S008RawProvidedInterface, 'id' | 'version'>
): number {
  if (provider.id !== requirement.id) return EUREKA_INCOMPARABLE;
  const provided = versionParts(provider.version, 0);
  if (!provided) return EUREKA_INCOMPARABLE;

  for (let index = 0; ; index++) {
    const required = versionParts(requirement.version, index);
    if (!required) break;
    if (provided[0] !== required[0]) continue;
    const minor = provided[1] - required[1];
    if (minor > 0) return 2;
    if (minor < 0) return -2;
    const patch = provided[2] - required[2];
    if (patch > 0) return 1;
    if (patch < 0) return -1;
    return 0;
  }
  return EUREKA_INCOMPARABLE;
}

export function isEurekaInterfaceCompatible(
  provider: Pick<S008RawProvidedInterface, 'id' | 'version'>,
  requirement: Pick<S008RawProvidedInterface, 'id' | 'version'>
): boolean {
  const comparison = compareEurekaInterfaces(provider, requirement);
  return comparison >= 0 && comparison <= 2;
}

export function isSupportedEurekaVersionExpression(version: string, provider = false): boolean {
  if (!versionParts(version, 0)) return false;
  if (provider) return true;
  for (let index = 0; index < javaSplit(version, ' ').length; index++) {
    if (!versionParts(version, index)) return false;
  }
  return true;
}

function versionParts(version: string, index: number): [number, number, number] | undefined {
  const alternatives = javaSplit(version, ' ');
  if (alternatives.length <= index) return undefined;
  const parts = javaSplit(alternatives[index], '.');
  if (parts.length < 2 || parts.length > 3) return undefined;
  const values = parts.map(javaInteger);
  if (values.some(value => value === undefined)) return undefined;
  return [values[0]!, values[1]!, parts.length === 3 ? values[2]! : -1];
}

function javaSplit(value: string, separator: string): string[] {
  const parts = value.split(separator);
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function javaInteger(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647 ? parsed : undefined;
}
