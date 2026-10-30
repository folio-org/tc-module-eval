import { isRecord } from './type-guards';

export interface DescriptorHandler {
  methods: string[];
  pathPattern?: string;
  /** Okapi's legacy prefix path, which a handler may give instead of `pathPattern`. */
  path?: unknown;
}

export interface DescriptorInterface {
  id: string;
  version: string;
  interfaceType?: string;
  handlers: DescriptorHandler[];
}

/** Okapi names system interfaces with a leading underscore (`_tenant`, `_timer`) or types them `system`. */
export function isSystemInterface(provided: Record<string, unknown>): boolean {
  return String(provided.id).startsWith('_') || provided.interfaceType === 'system';
}

/** The interfaces a module descriptor provides, with their handlers in descriptor order; system interfaces only when asked for. */
export function providedInterfaces(descriptor: unknown, includeSystem = false): DescriptorInterface[] {
  const provides = isRecord(descriptor) && Array.isArray(descriptor.provides) ? descriptor.provides.filter(isRecord) : [];
  return provides.flatMap(provided => {
    const id = String(provided.id);
    const interfaceType = typeof provided.interfaceType === 'string' ? provided.interfaceType : undefined;
    if (!includeSystem && isSystemInterface(provided)) return [];
    const handlers = (Array.isArray(provided.handlers) ? provided.handlers.filter(isRecord) : []).map(handler => ({
      methods: Array.isArray(handler.methods) ? handler.methods.filter((method): method is string => typeof method === 'string') : [],
      ...(typeof handler.pathPattern === 'string' ? { pathPattern: handler.pathPattern } : {}),
      ...(handler.path !== undefined ? { path: handler.path } : {})
    }));
    return [{ id, version: String(provided.version), ...(interfaceType ? { interfaceType } : {}), handlers }];
  });
}
