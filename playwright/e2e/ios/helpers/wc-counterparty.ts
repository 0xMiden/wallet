import SignClient from '@walletconnect/sign-client';
import { buildApprovedNamespaces } from '@walletconnect/utils';
import { createWalletClient, defineChain, http, numberToHex, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/**
 * Headless WalletConnect v2 counterparty "wallet" for the bridge-IN iOS harness.
 *
 * It plays the WALLET/responder side of the real WalletConnect handshake the app
 * (native Reown) initiates: pairs off the `wc:` URI (from the app's `connectUri`
 * hook), approves an `eip155:11155111` session for a viem local account, and
 * answers the app's `eth_sendTransaction` / `personal_sign` / `eth_signTypedData`
 * requests — signing + broadcasting to a LOCAL Anvil. The WalletConnect handshake
 * + signing are 100% real; only the chain (Anvil) and the URI delivery are local.
 *
 * Pairing rides the public relay (relay.walletconnect.org) with the app's
 * project id, so it is NOT hermetic on the connection layer (by design — the same
 * external dependency class as bridge-out's hosted services).
 */

const RELAY_URL = process.env.WC_RELAY_URL ?? 'wss://relay.walletconnect.org';
const PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID ?? 'b54ef53f878d160bf63c6eae3a567e67';
const ANVIL_RPC = process.env.E2E_EVM_RPC_URL ?? 'http://127.0.0.1:8545';
const CHAIN_ID = 11155111;
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
  params: unknown;
  result?: unknown;
  error?: string;
}

export class WcCounterparty {
  readonly account: PrivateKeyAccount;
  private client!: Awaited<ReturnType<typeof SignClient.init>>;
  private wallet: WalletClient;
  private topic?: string;
  private connectedResolve!: () => void;
  /** Resolves once a session is approved (the app reports connected). */
  readonly connected: Promise<void>;
  /** Every session_request handled, for assertions. */
  readonly requests: WcRequestLog[] = [];

  constructor(opts: { privateKey?: `0x${string}`; rpcUrl?: string } = {}) {
    this.account = privateKeyToAccount(opts.privateKey ?? (DEFAULT_KEY as `0x${string}`));
    this.wallet = createWalletClient({
      account: this.account,
      chain: anvilChain,
      transport: http(opts.rpcUrl ?? ANVIL_RPC)
    });
    this.connected = new Promise<void>(res => {
      this.connectedResolve = res;
    });
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  async start(): Promise<void> {
    this.client = await SignClient.init({
      projectId: PROJECT_ID,
      relayUrl: RELAY_URL,
      metadata: {
        name: 'Bridge-in E2E Wallet',
        description: 'Headless WC counterparty for the bridge-in harness',
        url: 'https://miden.io',
        icons: []
      }
    });

    this.client.on('session_proposal', async proposal => {
      try {
        const namespaces = buildApprovedNamespaces({
          proposal: proposal.params,
          supportedNamespaces: {
            eip155: {
              chains: [`eip155:${CHAIN_ID}`],
              methods: [
                'eth_sendTransaction',
                'personal_sign',
                'eth_sign',
                'eth_signTypedData',
                'eth_signTypedData_v4'
              ],
              events: ['chainChanged', 'accountsChanged'],
              accounts: [`eip155:${CHAIN_ID}:${this.account.address}`]
            }
          }
        });
        const { topic, acknowledged } = await this.client.approve({ id: proposal.id, namespaces });
        this.topic = topic;
        await acknowledged();
        this.connectedResolve();
      } catch (err) {
        console.error('[wc-counterparty] approve failed', err);
      }
    });

    this.client.on('session_request', async event => this.handleRequest(event));
  }

  async pair(uri: string): Promise<void> {
    await this.client.pair({ uri });
  }

  private async handleRequest(event: {
    topic: string;
    id: number;
    params: { request: { method: string; params: unknown } };
  }): Promise<void> {
    const { topic, id, params } = event;
    const { method, params: rpcParams } = params.request;
    const log: WcRequestLog = { method, params: rpcParams };
    try {
      let result: unknown;
      if (method === 'eth_sendTransaction') {
        const tx = (rpcParams as Array<Record<string, string>>)[0];
        if (!tx) throw new Error('eth_sendTransaction: missing tx params');
        result = await this.wallet.sendTransaction({
          account: this.account,
          chain: anvilChain,
          to: tx.to as `0x${string}`,
          data: (tx.data as `0x${string}`) ?? undefined,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined
        });
      } else if (method === 'personal_sign' || method === 'eth_sign') {
        const arr = rpcParams as string[];
        const raw = (method === 'personal_sign' ? arr[0] : arr[1]) as `0x${string}`;
        result = await this.account.signMessage({ message: { raw } });
      } else if (method.startsWith('eth_signTypedData')) {
        const arr = rpcParams as string[];
        const typed = typeof arr[1] === 'string' ? JSON.parse(arr[1]) : arr[1];
        result = await this.account.signTypedData(typed);
      } else {
        throw new Error(`unsupported method ${method}`);
      }
      log.result = result;
      this.requests.push(log);
      await this.client.respond({ topic, response: { id, jsonrpc: '2.0', result: result as string } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error = message;
      this.requests.push(log);
      await this.client.respond({
        topic,
        response: { id, jsonrpc: '2.0', error: { code: 5000, message } }
      });
    }
  }

  async stop(): Promise<void> {
    try {
      if (this.topic) {
        await this.client.disconnect({
          topic: this.topic,
          reason: { code: 6000, message: 'test complete' }
        });
      }
      await this.client.core.relayer.transportClose();
    } catch {
      /* best-effort cleanup */
    }
  }

  // Marker so `numberToHex` is retained for chainId responses if needed later.
  static chainIdHex = numberToHex(CHAIN_ID);
}
