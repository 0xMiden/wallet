import { createPublicClient, createWalletClient, http, isHex, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20_ABI } from './arc-usdcx';
import type { ClaimReceipt, ExitStep } from './mainnet-agglayer-exit';
import { AGGLAYER_BRIDGE_ABI } from '../../../src/lib/agglayer/constant';
import { midenAddrToEvmAddr } from '../../../src/lib/agglayer/contract';
import type { AgglayerDeposit, AgglayerMerkleProof } from '../../../src/lib/agglayer/status';
import { XRESERVE_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

type SmtProof = readonly [
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex
];

function hexValue(value: string, label: string): Hex {
  if (!isHex(value)) throw new Error(`${label} is not hex`);
  return value;
}

function zeroBytes32(): Hex {
  const word = `0x${'00'.repeat(32)}`;
  if (!isHex(word)) throw new Error('zero word is not hex');
  return word;
}

function isSmtProof(words: readonly Hex[]): words is SmtProof {
  return words.length === 32;
}

function padSmtProof(leaves: string[]): SmtProof {
  const empty = zeroBytes32();
  const words: Hex[] = [];
  for (let index = 0; index < 32; index += 1) {
    const leaf = leaves[index];
    words.push(leaf === undefined ? empty : hexValue(leaf, `smt proof leaf ${index}`));
  }
  if (!isSmtProof(words)) throw new Error('smt proof is not 32 words');
  return words;
}

function clientFor(chain: Chain, rpcUrl: string, key: Hex) {
  const account = privateKeyToAccount(key);
  const transport = http(rpcUrl);
  return {
    account,
    publicClient: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ account, chain, transport })
  };
}

/** Approve if needed, then `depositToRemote` of `units` with a zero Circle fee. */
export async function depositXReserve(args: {
  key: Hex;
  chain: Chain;
  rpcUrl: string;
  usdc: Address;
  xReserve: Address;
  units: bigint;
  remoteDomain: number;
  accountHex: string;
}): Promise<Hex> {
  const { publicClient, wallet, account } = clientFor(args.chain, args.rpcUrl, args.key);
  const allowance = await publicClient.readContract({
    address: args.usdc,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, args.xReserve]
  });
  if (allowance < args.units) {
    const approve = await wallet.writeContract({
      address: args.usdc,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [args.xReserve, args.units]
    });
    await publicClient.waitForTransactionReceipt({ hash: approve });
  }
  const recipient = midenAccountHexToXReserveRecipient(args.accountHex);
  const hash = await wallet.writeContract({
    address: args.xReserve,
    abi: XRESERVE_ABI,
    functionName: 'depositToRemote',
    args: [args.units, args.remoteDomain, recipient, args.usdc, 0n, '0x']
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Bridge `wei` of native ETH from Ethereum to the Miden account on Cedar (rollup 30). */
export async function bridgeEthToMiden(args: {
  key: Hex;
  chain: Chain;
  rpcUrl: string;
  bridge: Address;
  rollupId: number;
  midenAddress: string;
  wei: bigint;
}): Promise<Hex> {
  const { publicClient, wallet } = clientFor(args.chain, args.rpcUrl, args.key);
  const hash = await wallet.writeContract({
    address: args.bridge,
    abi: AGGLAYER_BRIDGE_ABI,
    functionName: 'bridgeAsset',
    args: [args.rollupId, midenAddrToEvmAddr(args.midenAddress), args.wei, ZERO, true, '0x'],
    value: args.wei
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

function isFetchTimeout(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** A `claimAsset` was broadcast and the receipt wait rejected. `hash` is the transaction that was paid for. */
export class AgglayerClaimPendingError extends Error {
  readonly hash: Hex;

  constructor(hash: Hex, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgglayerClaimPendingError';
    this.hash = hash;
  }
}

/** The claim failed before any transaction was built, so it spent nothing and costs no attempt. */
export class AgglayerClaimNotSentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgglayerClaimNotSentError';
  }
}

/** How many `claimAsset` broadcasts one night may send. */
export const SELF_CLAIM_ATTEMPTS = 2;

/**
 * Whether this lap may send `claimAsset`. False while a broadcast hash is still pending. Otherwise true only when
 * the step is `claim`, fewer than `SELF_CLAIM_ATTEMPTS` have been tried, and the on-chain `isClaimed` read is false.
 */
export function shouldBroadcastClaim(args: {
  pendingClaim: Hex | undefined;
  step: ExitStep['kind'];
  attempts: number;
  claimed: boolean | undefined;
}): boolean {
  if (args.pendingClaim !== undefined) return false;
  return args.step === 'claim' && args.attempts < SELF_CLAIM_ATTEMPTS && args.claimed === false;
}

export async function claimAgglayerOnEthereum(args: {
  key: Hex;
  chain: Chain;
  rpcUrl: string;
  bridge: Address;
  indexerUrl: string;
  deposit: AgglayerDeposit & { global_index?: string | number };
}): Promise<Hex> {
  const proof = await fetch(
    `${args.indexerUrl}/merkle-proof?deposit_cnt=${args.deposit.deposit_cnt}&net_id=${args.deposit.network_id}`,
    { signal: AbortSignal.timeout(15_000) }
  )
    .then(async response => {
      if (!response.ok) throw new AgglayerClaimNotSentError(`AggLayer merkle proof answered ${response.status}`);
      const body = (await response.json()) as { proof: AgglayerMerkleProof };
      return body.proof;
    })
    .catch((error: unknown) => {
      if (error instanceof AgglayerClaimNotSentError) throw error;
      const reason = isFetchTimeout(error) ? 'was not read within 15s' : 'could not be read';
      throw new AgglayerClaimNotSentError(`the AggLayer merkle proof ${reason}`, { cause: error });
    });
  if (args.deposit.global_index === undefined) {
    throw new AgglayerClaimNotSentError('AggLayer deposit has no global index, so the claim was not sent');
  }
  const metadata =
    args.deposit.metadata && args.deposit.metadata !== '0x' ? hexValue(args.deposit.metadata, 'metadata') : '0x';
  const { publicClient, wallet } = clientFor(args.chain, args.rpcUrl, args.key);
  let broadcast: Hex | undefined;
  try {
    const hash = await wallet.writeContract({
      address: args.bridge,
      abi: AGGLAYER_BRIDGE_ABI,
      functionName: 'claimAsset',
      args: [
        padSmtProof(proof.merkle_proof),
        padSmtProof(proof.rollup_merkle_proof),
        BigInt(args.deposit.global_index),
        hexValue(proof.main_exit_root, 'main exit root'),
        hexValue(proof.rollup_exit_root, 'rollup exit root'),
        args.deposit.orig_net,
        hexValue(args.deposit.orig_addr, 'origin address'),
        args.deposit.dest_net,
        hexValue(args.deposit.dest_addr, 'destination address'),
        BigInt(args.deposit.amount),
        metadata
      ]
    });
    broadcast = hash;
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  } catch (error) {
    // The claim was already broadcast. A rejected receipt wait keeps that hash; a write that never
    // returned one stays the original error.
    if (broadcast === undefined) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AgglayerClaimPendingError(broadcast, message, { cause: error });
  }
}

/** Whether the L1 bridge has recorded a claim of `deposit`, whoever sent it and whatever the indexer says. */
export async function isExitClaimedOnEthereum(args: {
  chain: Chain;
  rpcUrl: string;
  bridge: Address;
  deposit: AgglayerDeposit;
}): Promise<boolean> {
  const client = createPublicClient({ chain: args.chain, transport: http(args.rpcUrl) });
  return client.readContract({
    address: args.bridge,
    abi: AGGLAYER_BRIDGE_ABI,
    functionName: 'isClaimed',
    args: [args.deposit.deposit_cnt, args.deposit.network_id]
  });
}

/** A claim transaction on Ethereum: its receipt, who sent it, and the block it landed in. */
export async function readEthereumClaim(args: {
  chain: Chain;
  rpcUrl: string;
  hash: Hex;
}): Promise<{ receipt: ClaimReceipt; from: Address; blockNumber: bigint; at: Date }> {
  const client = createPublicClient({ chain: args.chain, transport: http(args.rpcUrl) });
  const receipt = await client.getTransactionReceipt({ hash: args.hash });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return {
    receipt: { status: receipt.status, logs: receipt.logs },
    from: receipt.from,
    blockNumber: receipt.blockNumber,
    at: new Date(Number(block.timestamp) * 1000)
  };
}
