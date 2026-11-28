/**
 * @jest-environment node
 */
import { resolveWalletBatchStrategy } from '@epoch-protocol/epoch-intents-sdk/dist/gasless/capability.js';
import { executeWalletCallsSequential } from '@epoch-protocol/epoch-intents-sdk/dist/services/shared.js';
import {
  createPublicClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hash,
  type Hex,
  type WalletClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { batchDigest } from 'lib/evm-relay/batch';
import { createRelayProvider, createRelayWalletClient } from 'lib/evm-relay/provider';
import { CHAIN, EXECUTOR, SALT } from 'lib/evm-relay/testing';
import type { RelayAccount, RelaySubmission } from 'lib/evm-relay/types';
import { planRelaySignature } from 'lib/miden/relay-key/sign-rules';
import type { RelaySignRequest, RelaySignResult } from 'lib/shared/types';

// The Epoch SDK's EVM-collateral deposit (`depositToCompact`) through the relay provider: the wallet-client calls it
// makes, and how the relay answers each. These tests drive the SDK's own functions over a relay wallet client.

const relayKey = privateKeyToAccount('0x1772fe91fd5a0e606a5fed77763cffebdf7d0a44f86be481c60319286db10e6f');
const RELAY: Address = `0x${relayKey.address.slice(2).toLowerCase()}`;
const SEPOLIA_RELAY = { ...CHAIN, key: 'sepolia', chainId: sepolia.id };
const TOKEN: Address = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const COMPACT: Address = '0x00000000000000171ede64904551eedf3c6c9788';
const DEPOSIT_DATA: Hex = '0xcafe0001';
const START_MS = 1_800_000_000_000;

function relayAccount(): RelayAccount {
  return {
    chainId: sepolia.id,
    address: RELAY,
    mode: 'sponsor',
    executor: EXECUTOR,
    feeRecipient: null,
    needsAuthorization: false,
    authorizationNonce: 0,
    salt: SALT,
    sequence: 3n,
    feeTokens: [],
    allowedTargets: null,
    balances: []
  };
}

function receiptOf(hash: unknown): Record<string, unknown> {
  return {
    blockHash: `0x${'b0'.repeat(32)}`,
    blockNumber: '0x10',
    contractAddress: null,
    cumulativeGasUsed: '0x1',
    effectiveGasPrice: '0x1',
    from: EXECUTOR,
    gasUsed: '0x1',
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    to: RELAY,
    transactionHash: hash,
    transactionIndex: '0x0',
    type: '0x2'
  };
}

/** A relay wallet client on Sepolia over stub relay services, with a record of each request that viem sends. */
function relayWalletClient(): { client: WalletClient; submissions: RelaySubmission[]; methods: string[] } {
  const clock = { ms: START_MS };
  const submissions: RelaySubmission[] = [];
  const methods: string[] = [];
  const provider = createRelayProvider({
    chain: SEPOLIA_RELAY,
    address: RELAY,
    rpcUrl: 'https://rpc.example',
    sign: async (request: RelaySignRequest): Promise<RelaySignResult> => {
      const plan = planRelaySignature(request, {
        relayAddress: RELAY,
        chain: SEPOLIA_RELAY,
        nowSeconds: clock.ms / 1000
      });
      const signature = await relayKey.sign({ hash: plan.digest });
      switch (plan.op) {
        case 'authorization':
          return { op: 'authorization', authorization: { ...plan.authorization, r: SALT, s: SALT, yParity: 0 } };
        case 'batch':
          return { op: 'batch', digest: plan.digest, signature };
      }
    },
    fetchAccount: async () => relayAccount(),
    postRelay: async submission => {
      submissions.push(submission);
      const hash: Hash = `0x${String(submissions.length).padStart(2, '0').repeat(32)}`;
      const { chainId, evmAddress, batchNonce, salt, deadline, calls } = submission;
      const id: Hex = batchDigest(
        SEPOLIA_RELAY.calibur,
        { chainId, evmAddress, executor: EXECUTOR, batchNonce, salt, deadline },
        calls
      );
      return { id, state: 'succeeded', txHash: hash };
    },
    fetchJob: async () => {
      throw new Error('no job read expected');
    },
    readRpc: async (method, params) => {
      switch (method) {
        case 'eth_blockNumber':
          return '0x10';
        case 'eth_getTransactionReceipt':
          return receiptOf(Array.isArray(params) ? params[0] : undefined);
        default:
          throw new Error(`unexpected read ${method}`);
      }
    },
    now: () => clock.ms,
    sleep: async ms => {
      clock.ms += ms;
    }
  });
  const recorded = {
    ...provider,
    request: <T = unknown>(args: { method: string; params?: unknown }): Promise<T> => {
      methods.push(args.method);
      return provider.request<T>(args);
    }
  };
  return { client: createRelayWalletClient(recorded, sepolia), submissions, methods };
}

describe('the Epoch SDK deposit path through the relay provider', () => {
  it('picks the sequential strategy: the relay refuses wallet_getCapabilities, so the SDK sends no wallet_sendCalls', async () => {
    const { client, methods } = relayWalletClient();
    // The relay address delegates to Calibur, which is not an Epoch implementation.
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: custom({ request: async () => `0xef0100${CHAIN.calibur.address.slice(2)}` })
    });

    await expect(
      resolveWalletBatchStrategy({ walletClient: client, chainId: sepolia.id, user: RELAY, publicClient })
    ).resolves.toEqual({ mode: 'sequential-tx' });
    expect(methods).toEqual(['wallet_getCapabilities']);
  });

  it('relays approve and the Compact deposit as one batch each, in order, and gives the last mined hash', async () => {
    const { client, submissions, methods } = relayWalletClient();
    const approve = {
      to: TOKEN,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [COMPACT, 5n] }),
      value: 0n
    };
    const deposit = { to: COMPACT, data: DEPOSIT_DATA, value: 0n };
    const account = client.account;
    if (account === undefined) throw new Error('the relay wallet client has no account');

    const hash = await executeWalletCallsSequential(
      { apiBaseUrl: 'https://allocator.test', walletClient: client },
      [approve, deposit],
      account
    );

    expect(submissions.map(submission => submission.calls)).toEqual([[approve], [deposit]]);
    expect(hash).toBe(`0x${'02'.repeat(32)}`);
    // Each call: viem checks the chain, sends one transaction (one relay POST), and reads the mined receipt.
    expect(methods).toEqual([
      'eth_chainId',
      'eth_sendTransaction',
      'eth_getTransactionReceipt',
      'eth_chainId',
      'eth_sendTransaction',
      'eth_getTransactionReceipt'
    ]);
  });
});
