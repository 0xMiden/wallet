// Shared helpers of the evm-relay unit tests: fake bindings, the env, the requests and the JSON bodies.
import { keccak256 } from 'viem';

import type { RelayKind } from '../../../src/lib/evm-relay/batch';
import type { AccountState, ChainReader } from '../src/chain';
import type { ChainConfig, Hex } from '../src/config';
import { isRecord } from '../src/http';
import { handleRequest } from '../src/index';
import type { Env } from '../src/types';

export const ORIGIN = 'chrome-extension://wallet-test';
export const BASE_URL = 'https://evm-relay.test';
export const RELAY_ID = `0x${'ab'.repeat(32)}`;
/** A valid relayer key of the tests. Its address is TEST_EXECUTOR. */
export const TEST_RELAYER_KEY = `0x${'11'.repeat(32)}`;
export const TEST_EXECUTOR: Hex = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
export const TEST_RPC_URL = 'https://rpc.example/secret-key';

/** A stand-in for the Calibur runtime code. The pin of the test chains is its keccak256. */
export const IMPLEMENTATION_CODE: Hex = '0x6080604052600436106100';
export const CALIBUR_ADDRESS: Hex = `0x${'ca'.repeat(20)}`;
export const USDC: Hex = `0x${'aa'.repeat(20)}`;
export const NATIVE: Hex = `0x${'0'.repeat(40)}`;
export const FEE_RECIPIENT: Hex = `0x${'fe'.repeat(20)}`;
export const BRIDGE: Hex = `0x${'2a'.repeat(20)}`;

/** A chain entry of RELAY_CONFIG with USDC and the native coin, valid in both gas modes. */
export function chainEntry(agglayer = true): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    calibur: {
      address: CALIBUR_ADDRESS,
      runtimeHash: keccak256(IMPLEMENTATION_CODE),
      domainName: 'Calibur',
      domainVersion: '1.0.0'
    },
    feeRecipient: FEE_RECIPIENT,
    tokens: { [USDC]: { minAmount: '2000000', fee: '100000' }, [NATIVE]: { minAmount: '1000', fee: '10' } }
  };
  if (agglayer) entry.agglayer = { bridgeAddress: BRIDGE, midenNetworkId: 1, forceUpdateGlobalExitRoot: true };
  return entry;
}

/** RELAY_CONFIG with the chain 8453 only. */
export function oneChainConfig(): string {
  return JSON.stringify({ chains: { '8453': chainEntry() } });
}

/** The account state that the fake reader returns, unless a test sets another. */
export function readState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    delegated: true,
    authorizationNonce: 3,
    salt: `0x${'00'.repeat(12)}${'ca'.repeat(20)}`,
    balances: [],
    sequences: new Map(),
    ...overrides
  };
}

/** A chain reader that answers from memory and records each call. */
export class FakeReader implements ChainReader {
  readonly calls: { chainId: number; address: Hex; kinds: readonly RelayKind[] }[] = [];
  state: AccountState = readState();
  error: Error | null = null;

  async readAccount(chain: ChainConfig, address: Hex, kinds: readonly RelayKind[]): Promise<AccountState> {
    this.calls.push({ chainId: chain.chainId, address, kinds });
    if (this.error !== null) throw this.error;
    return this.state;
  }
}

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
  relayerKey?: string | null;
  /** The `RPC_URL_<chainId>` secrets, keyed by chain id. */
  rpcUrls?: Record<string, string>;
}

export interface Harness {
  env: Env;
  readLimit: FakeRateLimit;
  relayLimit: FakeRateLimit;
  reader: FakeReader;
}

export function createHarness(options: EnvOptions = {}): Harness {
  const readLimit = new FakeRateLimit();
  const relayLimit = new FakeRateLimit();
  const env: Env = { ALLOWED_ORIGINS: options.allowedOrigins ?? JSON.stringify([ORIGIN]) };
  const relayerKey = options.relayerKey === undefined ? TEST_RELAYER_KEY : options.relayerKey;
  if (relayerKey !== null) env.RELAYER_PRIVATE_KEY = relayerKey;
  for (const [chainId, url] of Object.entries(options.rpcUrls ?? {})) Reflect.set(env, `RPC_URL_${chainId}`, url);
  if (options.readLimit !== false) env.READ_RATE_LIMIT = readLimit;
  if (options.relayLimit !== false) env.RELAY_RATE_LIMIT = relayLimit;
  const revision = options.revision === undefined ? 'test-revision' : options.revision;
  if (revision !== null) env.DEPLOYMENT_REVISION = revision;
  const gasMode = options.gasMode === undefined ? 'sponsor' : options.gasMode;
  if (gasMode !== null) env.GAS_MODE = gasMode;
  const relayConfig = options.relayConfig === undefined ? '{"chains":{}}' : options.relayConfig;
  if (relayConfig !== null) env.RELAY_CONFIG = relayConfig;
  return { env, readLimit, relayLimit, reader: new FakeReader() };
}

export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export function send(harness: Harness, path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = { method: options.method ?? 'GET', headers: { ...options.headers } };
  if (options.body !== undefined) init.body = options.body;
  return handleRequest(new Request(`${BASE_URL}${path}`, init), harness.env, harness.reader);
}

/** Read the response body as a JSON object. Fail the test when it is another value. */
export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('The response body is not a JSON object');
  return value;
}
