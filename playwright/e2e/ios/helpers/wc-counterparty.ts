import SignClient from '@walletconnect/sign-client';
import { buildApprovedNamespaces } from '@walletconnect/utils';
import { randomUUID } from 'node:crypto';
import { type Chain, createWalletClient, defineChain, type Hash, http, numberToHex, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { resolveCounterpartyEnv } from './wc-counterparty-env';
import { parseSendRequest, sessionNamespaces, type CounterpartyTransaction } from './wc-counterparty-request';

/**
 * Headless Reown (WalletConnect v2) counterparty wallet for the iOS bridge-in harnesses.
 *
 * It plays the wallet side of the real handshake the app's native Reown starts: it
 * pairs off the `wc:` URI from the app's `connectUri` hook, approves a session for
 * a viem local account, and answers the app's `eth_sendTransaction`,
 * `personal_sign` and `eth_signTypedData` requests. By default it signs for and
 * broadcasts to a LOCAL Anvil; a live run passes its own chain, RPC and a `send`
 * that signs on that chain. The handshake and the signing are real; only the URI
 * delivery is local.
 *
 * Pairing rides the public relay (relay.walletconnect.org), using the
 * counterparty's own project id when WC_COUNTERPARTY_PROJECT_ID is set, else
 * config.ts's resolution of the test process's own env, so it is NOT hermetic
 * on the connection layer (by design: the same external dependency class as
 * bridge-out's hosted services).
 */

// The counterparty authenticates its OWN relay connection, independent of the
// app's: peers don't need to share a project id. A dedicated one
// (WC_COUNTERPARTY_PROJECT_ID) halves the per-project relay load; the trimmed,
// empty-as-unset resolution (and the RELAY_URL / ANVIL_RPC defaults) live in
// wc-counterparty-env.ts.
const { relayUrl: RELAY_URL, projectId: PROJECT_ID, anvilRpc: ANVIL_RPC } = resolveCounterpartyEnv();
const CHAIN_ID = 11155111;
// The app proposes every chain in SUPPORTED_CHAINS (src/lib/walletconnect/config.ts), so by default the session
// approves Arc Testnet too. Every request is still signed for and broadcast to the one local Anvil.
const ARC_TESTNET_CHAIN_ID = 5042002;
const DEFAULT_SESSION_CHAIN_IDS: readonly number[] = [CHAIN_ID, ARC_TESTNET_CHAIN_ID];
// Anvil's first deterministic dev account (pre-funded with 10000 ETH).
const DEFAULT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const anvilChain = defineChain({
  id: CHAIN_ID,
  name: 'anvil-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } }
});

export interface WcRequestLog {
  method: string;
  /** The chain the app asked for, `eip155:<id>`. */
  chainId?: string;
  params: unknown;
  result?: unknown;
  error?: string;
}

export interface WcCounterpartyOptions {
  privateKey?: `0x${string}`;
  rpcUrl?: string;
  /**
   * The chain id of the node at `rpcUrl`, which every transaction is signed for.
   * Defaults to the local Anvil's (Sepolia's id). A live run passes its chain's id with that chain's RPC URL.
   */
  chainId?: number;
  /** The chains the session approves, of those the app proposes. Defaults to Sepolia and Arc Testnet. */
  sessionChainIds?: readonly number[];
  /**
   * Sends each transaction in place of the viem wallet client, once parseSendRequest accepted it for `chainId` and
   * the key. With it set every other method is refused, so a live key signs no message.
   */
  send?: (tx: CounterpartyTransaction, signal: AbortSignal) => Promise<Hash>;
}

type SessionProposal = { id: number; params: Parameters<typeof buildApprovedNamespaces>[0]['proposal'] };
type SessionRequest = {
  topic: string;
  id: number;
  params: { chainId: string; request: { method: string; params: unknown } };
};

export class WcCounterparty {
  readonly account: PrivateKeyAccount;
  private client?: Awaited<ReturnType<typeof SignClient.init>>;
  private wallet: WalletClient;
  private readonly chain: Chain;
  private readonly sessionChainIds: readonly number[];
  private readonly send?: WcCounterpartyOptions['send'];
  private readonly stopping = new AbortController();
  private stopped = false;
  private topic?: string;
  private connectedResolve!: () => void;
  /** Resolves once a session is approved (the app reports connected). */
  readonly connected: Promise<void>;
  /** Every session_request handled, for assertions. */
  readonly requests: WcRequestLog[] = [];

  constructor(opts: WcCounterpartyOptions = {}) {
    this.account = privateKeyToAccount(opts.privateKey ?? (DEFAULT_KEY as `0x${string}`));
    const rpcUrl = opts.rpcUrl ?? ANVIL_RPC;
    this.chain =
      opts.chainId === undefined
        ? anvilChain
        : defineChain({
            id: opts.chainId,
            name: `counterparty-${opts.chainId}`,
            nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
            rpcUrls: { default: { http: [rpcUrl] } }
          });
    this.wallet = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(rpcUrl)
    });
    this.sessionChainIds = opts.sessionChainIds ?? DEFAULT_SESSION_CHAIN_IDS;
    this.send = opts.send;
    this.connected = new Promise<void>(res => {
      this.connectedResolve = res;
    });
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  async start(): Promise<void> {
    if (this.client) return; // idempotent: connectWithRetry may call this too
    this.client = await SignClient.init({
      projectId: PROJECT_ID,
      relayUrl: RELAY_URL,
      // A Core of its own: without a prefix a second SignClient in one process reuses the first one's cached Core, and
      // a finished test's counterparty answered the next test's requests (E2E Bridge-IN's retry-only passes).
      customStoragePrefix: `wc-counterparty-${randomUUID()}`,
      metadata: {
        name: 'Bridge-in E2E Wallet',
        description: 'Headless Reown counterparty for the bridge-in harness',
        url: 'https://miden.io',
        icons: []
      }
    });
    this.client.on('session_proposal', this.onProposal);
    this.client.on('session_request', this.onRequest);
  }

  async pair(uri: string): Promise<void> {
    if (!this.client) throw new Error('the counterparty pairs only after start()');
    await this.client.pair({ uri });
  }

  /**
   * Robust connect: run the full Reown handshake (fetch a fresh `wc:` URI from the
   * app, pair, wait for the session to be approved, and confirm the app reports
   * connected) and retry the WHOLE handshake with backoff.
   *
   * The public relay rate-limits connection bursts and its subscribe can time out
   * ("Subscribing to <topic> failed, please try again"), which can hit the URI
   * fetch OR the pair/approve step. Retrying only the URI fetch left the subscribe
   * timeout fatal. A dedicated `WC_COUNTERPARTY_PROJECT_ID` (see the note at the
   * top of this file) is optional per-project load relief, never the fix; this
   * retry is what keeps the handshake resilient.
   */
  async connectWithRetry(
    getUri: () => Promise<string>,
    verifyAppConnected: () => Promise<boolean>,
    opts: { attempts?: number; backoffMs?: number; sessionTimeoutMs?: number } = {}
  ): Promise<void> {
    const { attempts = 5, backoffMs = 15_000, sessionTimeoutMs = 45_000 } = opts;
    await this.start();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const uri = await getUri();
        if (!uri.startsWith('wc:')) throw new Error(`expected a wc: pairing URI, got "${uri}"`);
        await this.pair(uri);
        // The relay subscribe inside pair/approve can stall without erroring;
        // bound the wait so a stall triggers a retry instead of hanging.
        await Promise.race([
          this.connected,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`WC session not approved within ${sessionTimeoutMs}ms (relay subscribe timeout?)`)),
              sessionTimeoutMs
            )
          )
        ]);
        for (let poll = 0; poll < 30; poll++) {
          if (await verifyAppConnected()) return;
          await this.sleep(2000);
        }
        throw new Error('WC session approved but the app never reported connected');
      } catch (err) {
        lastErr = err;
        if (attempt === attempts) {
          throw new Error(
            `WalletConnect handshake failed after ${attempts} attempts (public relay subscribe/rate-limit): ${String(lastErr)}`
          );
        }
        await this.sleep(backoffMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private readonly onProposal = async (proposal: SessionProposal): Promise<void> => {
    const client = this.client;
    if (this.stopped || !client) return;
    try {
      const namespaces = buildApprovedNamespaces({
        proposal: proposal.params,
        supportedNamespaces: sessionNamespaces(this.sessionChainIds, this.account.address)
      });
      const { topic, acknowledged } = await client.approve({ id: proposal.id, namespaces });
      this.topic = topic;
      await acknowledged();
      this.connectedResolve();
    } catch (err) {
      console.error('[wc-counterparty] approve failed', err);
    }
  };

  private readonly onRequest = async (event: SessionRequest): Promise<void> => {
    const client = this.client;
    // A stopped counterparty answers nothing: the app's request belongs to whichever counterparty the test runs now.
    if (this.stopped || !client) return;
    const { topic, id, params } = event;
    const { method, params: rpcParams } = params.request;
    const log: WcRequestLog = { method, chainId: params.chainId, params: rpcParams };
    try {
      const result = await this.answer(method, params.chainId, rpcParams);
      log.result = result;
      this.requests.push(log);
      await client.respond({ topic, response: { id, jsonrpc: '2.0', result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error = message;
      this.requests.push(log);
      await client.respond({
        topic,
        response: { id, jsonrpc: '2.0', error: { code: 5000, message } }
      });
    }
  };

  private async answer(method: string, chainId: string, rpcParams: unknown): Promise<string> {
    if (this.send) {
      if (method !== 'eth_sendTransaction') throw new Error(`${method}: this counterparty signs no message`);
      const tx = parseSendRequest(
        { chainId, params: rpcParams },
        { chainId: this.chain.id, from: this.account.address }
      );
      return this.send(tx, this.stopping.signal);
    }
    if (method === 'eth_sendTransaction') {
      const tx = (rpcParams as Array<Record<string, string>>)[0];
      if (!tx) throw new Error('eth_sendTransaction: missing tx params');
      return this.wallet.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: tx.to as `0x${string}`,
        data: (tx.data as `0x${string}`) ?? undefined,
        value: tx.value ? BigInt(tx.value) : undefined,
        gas: tx.gas ? BigInt(tx.gas) : undefined
      });
    }
    if (method === 'personal_sign' || method === 'eth_sign') {
      const arr = rpcParams as string[];
      const raw = (method === 'personal_sign' ? arr[0] : arr[1]) as `0x${string}`;
      return this.account.signMessage({ message: { raw } });
    }
    if (method.startsWith('eth_signTypedData')) {
      const arr = rpcParams as string[];
      const typed = typeof arr[1] === 'string' ? JSON.parse(arr[1]) : arr[1];
      return this.account.signTypedData(typed);
    }
    throw new Error(`unsupported method ${method}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort(new Error('the counterparty stopped'));
    const client = this.client;
    if (!client) return;
    client.off('session_proposal', this.onProposal);
    client.off('session_request', this.onRequest);
    try {
      if (this.topic) {
        await client.disconnect({
          topic: this.topic,
          reason: { code: 6000, message: 'test complete' }
        });
      }
      await client.core.relayer.transportClose();
    } catch {
      /* best-effort cleanup */
    }
  }

  // Marker so `numberToHex` is retained for chainId responses if needed later.
  static chainIdHex = numberToHex(CHAIN_ID);
}
