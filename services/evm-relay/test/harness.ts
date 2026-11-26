// Shared helpers of the evm-relay unit tests: fake bindings, the env, the requests and the JSON bodies.
import { keccak256, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { memoryDatabase, type MemoryDatabase } from './sqlite';
import type { AccountState, ChainReader, ReceiptStatus, RelayCall, RelayState } from '../src/chain';
import type { ChainConfig, Hex } from '../src/config';
import { isRecord } from '../src/http';
import { handleRequest } from '../src/index';
import { RelaySender, type SenderDirectory } from '../src/sender';
import type { RelaySenderObject } from '../src/sender-object';
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
/** A contract that a batch calls, for example a bridge. The relay does not know what it does. */
export const TARGET: Hex = `0x${'2a'.repeat(20)}`;

/** The Calibur pin of the test chains. */
export const CALIBUR_PIN = {
  address: CALIBUR_ADDRESS,
  runtimeHash: keccak256(IMPLEMENTATION_CODE),
  domainName: 'Calibur',
  domainVersion: '1.0.0'
};

/**
 * A chain entry of RELAY_CONFIG with fees in USDC and in the native coin, valid in both gas modes. It has no
 * `allowedTargets` unless `extra` sets it.
 */
export function chainEntry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { fees: { [USDC]: '100000', [NATIVE]: '10' }, ...extra };
}

/**
 * RELAY_CONFIG with the test Calibur pin, the test fee recipient and the chain entries `chains`. `top` adds or
 * replaces top fields.
 */
export function relayConfigOf(chains: Record<string, unknown> = {}, top: Record<string, unknown> = {}): string {
  return JSON.stringify({ calibur: CALIBUR_PIN, feeRecipient: FEE_RECIPIENT, chains, ...top });
}

/** RELAY_CONFIG with an entry for the chain 8453 only. */
export function oneChainConfig(): string {
  return relayConfigOf({ '8453': chainEntry() });
}

/** The account state that the fake reader returns, unless a test sets another. */
export function readState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    delegated: true,
    authorizationNonce: 3,
    salt: `0x${'00'.repeat(12)}${'ca'.repeat(20)}`,
    balances: [],
    sequence: 0n,
    ...overrides
  };
}

/**
 * The relay chain state that the fake reader returns, unless a test sets another. Its sequence 7 is the sequence of
 * the batches that the relay tests sign.
 */
export function relayState(overrides: Partial<RelayState> = {}): RelayState {
  return {
    delegated: true,
    authorizationNonce: 3,
    relayerNonce: 5,
    relayerBalance: 10n ** 18n,
    baseFee: 1_000_000_000n,
    priorityFee: 100_000_000n,
    gasEstimate: 200_000n,
    sequence: 7n,
    ...overrides
  };
}

/** A chain reader that answers from memory and records each call. */
export class FakeReader implements ChainReader {
  readonly calls: { chainId: number; address: Hex; tokens: readonly Hex[] }[] = [];
  readonly relayCalls: { chainId: number; call: RelayCall }[] = [];
  state: AccountState = readState();
  relay: RelayState = relayState();
  error: Error | null = null;

  async readAccount(chain: ChainConfig, address: Hex, tokens: readonly Hex[]): Promise<AccountState> {
    this.calls.push({ chainId: chain.chainId, address, tokens });
    if (this.error !== null) throw this.error;
    return this.state;
  }

  async readRelay(chain: ChainConfig, call: RelayCall): Promise<RelayState> {
    this.relayCalls.push({ chainId: chain.chainId, call });
    if (this.error !== null) throw this.error;
    return this.relay;
  }
}

/** The signer of signed type 2 or type 4 transaction bytes, lower case. */
export async function transactionSigner(raw: Hex): Promise<string> {
  const body = raw.slice(4);
  switch (raw.slice(0, 4)) {
    case '0x02':
      return (await recoverTransactionAddress({ serializedTransaction: `0x02${body}` })).toLowerCase();
    case '0x04':
      return (await recoverTransactionAddress({ serializedTransaction: `0x04${body}` })).toLowerCase();
    default:
      throw new Error('The bytes are not a type 2 or type 4 transaction');
  }
}

/** The signed transaction that a test Sender broadcast. */
export interface Broadcast {
  chainId: number;
  raw: Hex;
  /** The rows of the chain's Sender when the broadcast started. */
  storedRows: number;
}

/** Real Senders over node:sqlite: one per chain, with the test relayer key, a recording broadcast and a fake chain. */
export class TestSenders {
  readonly broadcasts: Broadcast[] = [];
  broadcastError: Error | null = null;
  /** The receipt status of each mined hash, on every chain. */
  readonly receipts = new Map<Hex, ReceiptStatus>();
  /** The armed alarm of each chain's Sender. */
  readonly alarms = new Map<number, number>();
  readonly databases = new Map<number, MemoryDatabase>();
  private readonly senders = new Map<number, RelaySender>();
  private readonly account = privateKeyToAccount(`0x${'11'.repeat(32)}`);

  readonly directory: SenderDirectory = chainId => {
    const sender = this.senderOf(chainId);
    return { get: async id => sender.get(id), submit: job => sender.submit(job) };
  };

  /** Every stored relay of the chain. */
  rows(chainId: number): Record<string, unknown>[] {
    return this.databaseOf(chainId).run('SELECT * FROM inflight ORDER BY nonce');
  }

  senderOf(chainId: number): RelaySender {
    const known = this.senders.get(chainId);
    if (known !== undefined) return known;
    const sender = new RelaySender({
      sql: this.databaseOf(chainId),
      relayer: () => TEST_EXECUTOR,
      sign: transaction => this.account.signTransaction(transaction),
      broadcast: async (target, raw) => {
        this.broadcasts.push({ chainId: target, raw, storedRows: this.rows(target).length });
        if (this.broadcastError !== null) throw this.broadcastError;
        return 'accepted';
      },
      receipts: async (_target, hashes) => hashes.map(hash => this.receipts.get(hash) ?? null),
      fees: async () => ({ baseFee: 1_000_000_000n, priorityFee: 100_000_000n }),
      alarmAt: async () => this.alarms.get(chainId) ?? null,
      schedule: async atMs => {
        this.alarms.set(chainId, atMs);
      },
      now: () => 1_700_000_000_000
    });
    this.senders.set(chainId, sender);
    return sender;
  }

  /** Run the alarm of the chain's Sender, as the runtime does: the alarm is no longer armed while it runs. */
  tick(chainId: number): Promise<void> {
    this.alarms.delete(chainId);
    return this.senderOf(chainId).tick();
  }

  private databaseOf(chainId: number): MemoryDatabase {
    const known = this.databases.get(chainId);
    if (known !== undefined) return known;
    const database = memoryDatabase();
    this.databases.set(chainId, database);
    return database;
  }
}

/** A Durable Object binding for /healthz. The tests reach the Senders through TestSenders, never through it. */
class UnusedNamespace implements DurableObjectNamespace<RelaySenderObject> {
  newUniqueId(): never {
    throw new Error('The tests do not use the binding.');
  }
  idFromName(): never {
    throw new Error('The tests do not use the binding.');
  }
  idFromString(): never {
    throw new Error('The tests do not use the binding.');
  }
  get(): never {
    throw new Error('The tests do not use the binding.');
  }
  getByName(): never {
    throw new Error('The tests do not use the binding.');
  }
  jurisdiction(): never {
    throw new Error('The tests do not use the binding.');
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
  /** The served chains: each one gets the secret `RPC_URL_<chainId>` with TEST_RPC_URL. */
  chains?: readonly number[];
  /** More `RPC_URL_<chainId>` secrets, keyed by chain id. They replace the URL of a chain in `chains`. */
  rpcUrls?: Record<string, string>;
  senderBinding?: boolean;
}

export interface Harness {
  env: Env;
  readLimit: FakeRateLimit;
  relayLimit: FakeRateLimit;
  reader: FakeReader;
  senders: TestSenders;
}

export function createHarness(options: EnvOptions = {}): Harness {
  const readLimit = new FakeRateLimit();
  const relayLimit = new FakeRateLimit();
  const env: Env = { ALLOWED_ORIGINS: options.allowedOrigins ?? JSON.stringify([ORIGIN]) };
  const relayerKey = options.relayerKey === undefined ? TEST_RELAYER_KEY : options.relayerKey;
  if (relayerKey !== null) env.RELAYER_PRIVATE_KEY = relayerKey;
  for (const chainId of options.chains ?? []) Reflect.set(env, `RPC_URL_${chainId}`, TEST_RPC_URL);
  for (const [chainId, url] of Object.entries(options.rpcUrls ?? {})) Reflect.set(env, `RPC_URL_${chainId}`, url);
  if (options.readLimit !== false) env.READ_RATE_LIMIT = readLimit;
  if (options.relayLimit !== false) env.RELAY_RATE_LIMIT = relayLimit;
  if (options.senderBinding !== false) env.RELAY_SENDER = new UnusedNamespace();
  const revision = options.revision === undefined ? 'test-revision' : options.revision;
  if (revision !== null) env.DEPLOYMENT_REVISION = revision;
  const gasMode = options.gasMode === undefined ? 'sponsor' : options.gasMode;
  if (gasMode !== null) env.GAS_MODE = gasMode;
  const relayConfig = options.relayConfig === undefined ? relayConfigOf() : options.relayConfig;
  if (relayConfig !== null) env.RELAY_CONFIG = relayConfig;
  return { env, readLimit, relayLimit, reader: new FakeReader(), senders: new TestSenders() };
}

export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export function send(harness: Harness, path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = { method: options.method ?? 'GET', headers: { ...options.headers } };
  if (options.body !== undefined) init.body = options.body;
  const request = new Request(`${BASE_URL}${path}`, init);
  return handleRequest(request, harness.env, harness.reader, harness.senders.directory);
}

/** Read the response body as a JSON object. Fail the test when it is another value. */
export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('The response body is not a JSON object');
  return value;
}
