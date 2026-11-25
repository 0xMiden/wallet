// Shared helpers of the evm-relay unit tests: fake bindings, the env, the requests and the JSON bodies.
import { isRecord } from '../src/http';
import { handleRequest } from '../src/index';
import type { Env } from '../src/types';

export const ORIGIN = 'chrome-extension://wallet-test';
export const BASE_URL = 'https://evm-relay.test';
export const RELAY_ID = `0x${'ab'.repeat(32)}`;

export class FakeRateLimit implements RateLimit {
  /** The key of every call, in order. */
  readonly keys: string[] = [];
  private readonly used = new Map<string, number>();

  constructor(private budget = Number.POSITIVE_INFINITY) {}

  /** Set the number of successful calls of each key, from the next call on. */
  allow(budget: number): void {
    this.budget = budget;
    this.used.clear();
  }

  async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(key);
    const used = this.used.get(key) ?? 0;
    if (used >= this.budget) return { success: false };
    this.used.set(key, used + 1);
    return { success: true };
  }
}

/** Which bindings and variables the env holds. Each one has a valid value when the option is absent. */
export interface EnvOptions {
  readLimit?: boolean;
  relayLimit?: boolean;
  allowedOrigins?: string;
  revision?: string | null;
  gasMode?: string | null;
  relayConfig?: string | null;
}

export interface Harness {
  env: Env;
  readLimit: FakeRateLimit;
  relayLimit: FakeRateLimit;
}

export function createHarness(options: EnvOptions = {}): Harness {
  const readLimit = new FakeRateLimit();
  const relayLimit = new FakeRateLimit();
  const env: Env = { ALLOWED_ORIGINS: options.allowedOrigins ?? JSON.stringify([ORIGIN]) };
  if (options.readLimit !== false) env.READ_RATE_LIMIT = readLimit;
  if (options.relayLimit !== false) env.RELAY_RATE_LIMIT = relayLimit;
  const revision = options.revision === undefined ? 'test-revision' : options.revision;
  if (revision !== null) env.DEPLOYMENT_REVISION = revision;
  const gasMode = options.gasMode === undefined ? 'sponsor' : options.gasMode;
  if (gasMode !== null) env.GAS_MODE = gasMode;
  const relayConfig = options.relayConfig === undefined ? '{"chains":{}}' : options.relayConfig;
  if (relayConfig !== null) env.RELAY_CONFIG = relayConfig;
  return { env, readLimit, relayLimit };
}

export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export function send(harness: Harness, path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = { method: options.method ?? 'GET', headers: { ...options.headers } };
  if (options.body !== undefined) init.body = options.body;
  return handleRequest(new Request(`${BASE_URL}${path}`, init), harness.env);
}

/** Read the response body as a JSON object. Fail the test when it is another value. */
export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('The response body is not a JSON object');
  return value;
}
