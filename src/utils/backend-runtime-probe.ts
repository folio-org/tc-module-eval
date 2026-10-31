import type { BackendRuntimeRequest } from '../types';

export interface ProbeInput {
  phase: 'egress' | 'health' | 'tenants' | 'requests';
  moduleUrl: string;
  okapiUrl: string;
  requestTimeoutMs: number;
  bodyChars: number;
  maxResponseBytes: number;
  egressTargets?: Array<{ host: string; port: number }>;
  dnsName?: string;
  waitMs?: number;
  pollMs?: number;
  tenants?: string[];
  moduleId?: string;
  getPaths?: string[];
  collections?: Array<{ path: string; itemPath?: string }>;
  maxCollections?: number;
  budgetMs?: number;
}

export interface ProbeOutput {
  egress?: Array<{ target: string; result: string }>;
  health?: BackendRuntimeRequest & { attempts: number };
  tenants?: Array<BackendRuntimeRequest & { complete?: boolean }>;
  getRequests?: BackendRuntimeRequest[];
  crossTenant?: {
    path?: string;
    recordId?: string;
    visibleInOwnTenant?: boolean;
    visibleInOtherTenant?: boolean;
    problem?: string;
    requests: BackendRuntimeRequest[];
  };
}

/**
 * Runs in the probe container on the module's network, so it uses only Node built-ins and nothing outside its own
 * body. It writes only to `/_/tenant` and, for the cross-tenant check, to one collection path from the input.
 */
export async function runtimeProbe(input: ProbeInput): Promise<ProbeOutput> {
  const http = require('http') as typeof import('http');
  const net = require('net') as typeof import('net');
  const dns = require('dns') as typeof import('dns');
  const crypto = require('crypto') as typeof import('crypto');
  const tokenPart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const userId = '00000000-0000-4000-8000-000000000001';
  const stopAt = Date.now() + (input.budgetMs ?? 600_000);
  const outOfTime = () => Date.now() >= stopAt;
  const notSent = 'not sent: the time budget ran out';

  type Response = { status?: number; text: string; complete: boolean; error?: string; location?: string };
  const request = (method: string, path: string, tenant: string | undefined, body?: string): Promise<Response> => new Promise(resolve => {
    const url = new URL(`${input.moduleUrl}${path}`);
    if (url.origin !== new URL(input.moduleUrl).origin || !path.startsWith('/')) {
      resolve({ text: '', complete: false, error: 'not sent: the path leads outside the module' });
      return;
    }
    const headers: Record<string, string> = { Accept: 'application/json, text/plain', 'X-Okapi-Url': input.okapiUrl };
    if (tenant) {
      headers['X-Okapi-Tenant'] = tenant;
      headers['X-Okapi-User-Id'] = userId;
      headers['X-Okapi-Token'] = `${tokenPart({ alg: 'none' })}.${tokenPart({ sub: 'tc-module-eval', user_id: userId, tenant })}.`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const sent = http.request(url, { method, headers, timeout: input.requestTimeoutMs }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let complete = true;
      response.on('data', (chunk: Buffer) => {
        if (bytes + chunk.length > input.maxResponseBytes) {
          chunks.push(chunk.subarray(0, input.maxResponseBytes - bytes));
          bytes = input.maxResponseBytes;
          complete = false;
          response.destroy();
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });
      const done = () => resolve({
        status: response.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
        complete,
        ...(typeof response.headers.location === 'string' ? { location: response.headers.location } : {})
      });
      response.on('end', done);
      response.on('close', done);
      response.on('error', done);
    });
    sent.on('timeout', () => sent.destroy(new Error(`no response within ${input.requestTimeoutMs} ms`)));
    sent.on('error', error => resolve({ text: '', complete: false, error: error.message.slice(0, 200) }));
    sent.end(body);
  });
  const parse = (response: Response): unknown => {
    if (!response.complete) return undefined;
    try {
      return JSON.parse(response.text);
    } catch {
      return undefined;
    }
  };
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const records = (value: unknown): Array<Record<string, unknown>> | undefined => {
    if (!isObject(value)) return undefined;
    for (const key of Object.keys(value)) {
      const entry = value[key];
      if (Array.isArray(entry) && entry.every(isObject)) return entry as Array<Record<string, unknown>>;
    }
    return undefined;
  };
  const recordCount = (value: unknown): number | undefined => {
    if (isObject(value) && typeof value.totalRecords === 'number') return value.totalRecords;
    return records(value)?.length;
  };
  const record = (method: string, path: string, tenant: string | undefined, response: Response, withBody: boolean): BackendRuntimeRequest => ({
    method,
    path,
    ...(tenant ? { tenant } : {}),
    ...(response.status !== undefined ? { status: response.status } : {}),
    ...(withBody && response.status !== undefined ? { body: response.text.slice(0, input.bodyChars) } : {}),
    ...(response.error ? { error: response.error } : {})
  });

  if (input.phase === 'egress') {
    const connect = (host: string, port: number) => new Promise<string>(resolve => {
      const socket = net.connect({ host, port, timeout: input.requestTimeoutMs });
      socket.on('connect', () => { socket.destroy(); resolve('connected'); });
      socket.on('timeout', () => { socket.destroy(); resolve('timed out'); });
      socket.on('error', (error: NodeJS.ErrnoException) => resolve(`failed (${error.code ?? error.message})`));
    });
    const egress = [];
    for (const target of input.egressTargets ?? []) egress.push({ target: `${target.host}:${target.port}`, result: await connect(target.host, target.port) });
    if (input.dnsName) {
      const name = input.dnsName;
      egress.push({
        target: `DNS ${name}`,
        result: await new Promise<string>(resolve => dns.lookup(name, (error, address) => resolve(error ? `failed (${error.code ?? error.message})` : `resolved to ${address}`)))
      });
    }
    return { egress };
  }

  if (input.phase === 'health') {
    const deadline = Date.now() + (input.waitMs ?? 0);
    let attempts = 0;
    let last: Response;
    do {
      attempts++;
      last = await request('GET', '/admin/health', undefined);
      if (last.status === 200) break;
      if (Date.now() + (input.pollMs ?? 2000) >= deadline) break;
      await sleep(input.pollMs ?? 2000);
    } while (Date.now() < deadline);
    return { health: { ...record('GET', '/admin/health', undefined, last, true), attempts } };
  }

  if (input.phase === 'tenants') {
    const tenants = [];
    for (const tenant of input.tenants ?? []) {
      if (outOfTime()) {
        tenants.push({ method: 'POST', path: '/_/tenant', tenant, error: notSent });
        continue;
      }
      const body = JSON.stringify({
        module_to: input.moduleId,
        parameters: [{ key: 'loadReference', value: 'true' }, { key: 'loadSample', value: 'false' }]
      });
      const response = await request('POST', '/_/tenant', tenant, body);
      const result: BackendRuntimeRequest & { complete?: boolean } = record('POST', '/_/tenant', tenant, response, !(response.status! >= 200 && response.status! < 300));
      const job = isObject(parse(response)) ? parse(response) as Record<string, unknown> : undefined;
      const jobPath = typeof job?.id === 'string' && /^[\w-]{1,64}$/.test(job.id) ? `/_/tenant/${job.id}` : undefined;
      if (response.status === 201 && jobPath) {
        let polled: Response | undefined;
        let complete = false;
        for (let attempt = 0; attempt < 10 && !complete && !outOfTime(); attempt++) {
          polled = await request('GET', `${jobPath}?wait=${Math.max(1_000, input.requestTimeoutMs - 5_000)}`, tenant);
          const state = parse(polled);
          complete = isObject(state) && state.complete === true;
          if (polled.status !== 200) break;
          if (complete && isObject(state) && typeof state.error === 'string') result.body = state.error.slice(0, input.bodyChars);
        }
        result.complete = complete;
      } else if (response.status !== undefined && response.status >= 200 && response.status < 300) {
        result.complete = true;
      }
      tenants.push(result);
    }
    return { tenants };
  }

  const [own, other] = input.tenants ?? [];
  const getRequests: BackendRuntimeRequest[] = [];
  for (const path of input.getPaths ?? []) {
    for (const tenant of [own, other]) {
      if (outOfTime()) {
        getRequests.push({ method: 'GET', path, tenant, error: notSent });
        continue;
      }
      const response = await request('GET', path, tenant);
      const count = recordCount(parse(response));
      getRequests.push({ ...record('GET', path, tenant, response, false), ...(count !== undefined ? { recordCount: count } : {}) });
    }
  }
  const crossTenant: NonNullable<ProbeOutput['crossTenant']> = { requests: [] };
  const step = async (method: string, path: string, tenant: string, body?: string) => {
    const response = await request(method, path, tenant, body);
    crossTenant.requests.push(record(method, path.split('?')[0], tenant, response, false));
    return response;
  };
  for (const collection of (input.collections ?? []).slice(0, input.maxCollections ?? 3)) {
    if (outOfTime()) {
      crossTenant.problem = 'the time budget ran out';
      break;
    }
    const listed = records(parse(await step('GET', `${collection.path}?limit=1`, own)));
    const template = listed?.[0];
    if (!template) {
      crossTenant.problem = `${collection.path} listed no record in ${own} to copy`;
      continue;
    }
    const recordId = crypto.randomUUID();
    const copy: Record<string, unknown> = { ...template, id: recordId };
    delete copy.metadata;
    for (const key of ['name', 'code', 'value', 'title', 'label', 'description']) {
      if (typeof copy[key] === 'string') copy[key] = `${copy[key]} tc-module-eval ${recordId.slice(0, 8)}`;
    }
    const created = await step('POST', collection.path, own, JSON.stringify(copy));
    if (created.status === undefined || created.status < 200 || created.status >= 300) {
      crossTenant.problem = `POST ${collection.path} in ${own} answered ${created.status ?? created.error}`;
      continue;
    }
    const answer = parse(created);
    const id = isObject(answer) && typeof answer.id === 'string' ? answer.id : recordId;
    crossTenant.path = collection.path;
    crossTenant.recordId = id;
    delete crossTenant.problem;
    const visible = async (tenant: string): Promise<boolean | undefined> => {
      if (collection.itemPath) {
        const response = await step('GET', collection.itemPath.replace(/\{[^}]*\}/, encodeURIComponent(id)), tenant);
        return response.status === 200 ? true : response.status === 404 ? false : undefined;
      }
      const found = records(parse(await step('GET', `${collection.path}?limit=1000`, tenant)));
      return found ? found.some(item => item.id === id) : undefined;
    };
    crossTenant.visibleInOwnTenant = await visible(own);
    crossTenant.visibleInOtherTenant = await visible(other);
    break;
  }
  return { getRequests, ...(input.collections?.length ? { crossTenant } : {}) };
}

/** The probe container's program: the probe with its input, printing its output as one JSON line. */
export function probeProgram(input: ProbeInput): string {
  return `(${runtimeProbe.toString()})(${JSON.stringify(input)}).then(output => process.stdout.write(JSON.stringify(output)),`
    + ' error => { process.stdout.write(JSON.stringify({ error: String(error && error.message || error) })); });';
}
