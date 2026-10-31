/**
 * The source-chain leg of a usdcx-in-l2 deposit, signed in Node with the harness key. The wallet's own
 * runUsdcxExecutorDeposit (usdcx/executor.ts) drives it, so the balance checks, the quote, the approve for the amount plus
 * twice the fee, the second quote and the forwarded burn are the product's; only the signer, the chain reads and the
 * row write are the harness's.
 */
import { encodeFunctionData, formatEther, formatGwei, formatUnits, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  chainRead,
  ERC20_ABI,
  estimateUsdcxFees,
  onFirstEndpoint,
  pickWriteEndpoint,
  pinAfterApprove,
  readRemoteDomainRegistered,
  sendSigned,
  simulate,
  startingAt,
  waitForReceipt,
  type ArcReadDeps
} from './arc-usdcx';
import {
  ETHEREUM_SEPOLIA_PAYOUT,
  L2_BRIDGE_IN_GAS,
  USDCX_REMOTE_DOMAIN,
  type L2BridgeInSource,
  type PayoutChain
} from './usdcx-constants';
import type { IUsdcxCctpLeg } from '../../../src/lib/miden/db/types';
import type { CctpBurnQuote } from '../../../src/lib/usdcx/cctp';
import {
  buildExecutorBurnIntent,
  quoteExecutorBurn,
  runUsdcxExecutorDeposit,
  type DepositForBurnWithHookAndFeesArgs,
  type ExecutorBurnIntent,
  type UsdcxExecutorDepositDeps,
  type UsdcxExecutorSigner
} from '../../../src/lib/usdcx/executor';
import { CIRCLE_USDC_DECIMALS, TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

export function l2Reads(
  l2: L2BridgeInSource,
  overrides: Pick<ArcReadDeps, 'publicClient' | 'clock'> = {}
): ArcReadDeps {
  return { endpoints: l2.payout.rpcUrls, payoutChain: l2.payout, ...overrides };
}

export interface L2KeyFunds {
  wei: bigint;
  usdc: bigint;
  /** What a send bids per gas now, its tip capped as sendSigned caps it; a node refuses a send the key cannot cover. */
  maxFeePerGas: bigint;
}

export async function readL2KeyFunds(address: Address, reads: ArcReadDeps): Promise<L2KeyFunds> {
  const chain = reads.payoutChain;
  if (!chain) throw new Error('readL2KeyFunds reads a bridge-in source chain: its deps name no payoutChain');
  return onFirstEndpoint(reads, `${chain.label} funds of ${address}`, async client => ({
    wei: await client.getBalance({ address }),
    usdc: await client.readContract({
      address: chain.usdc,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address]
    }),
    maxFeePerGas: (await estimateUsdcxFees(client, chain)).maxFeePerGas
  }));
}

/** Circle's live quote for the deposit, bound to the hook data the product builds for this recipient and depositor. */
export function quoteL2Deposit(
  l2: L2BridgeInSource,
  args: { units: bigint; recipient: Hex; depositor: Address }
): Promise<CctpBurnQuote> {
  const amount = formatUnits(args.units, CIRCLE_USDC_DECIMALS);
  return quoteExecutorBurn(l2.source, buildExecutorBurnIntent(amount, l2.source, args.recipient, args.depositor));
}

/**
 * What the key lacks for one deposit on `label`, or undefined. ETH first, at L2_BRIDGE_IN_GAS and the live fee; then USDC
 * for the deposit and twice the quoted fee, since the approve covers twice the fee and the second quote may use it.
 */
export function l2KeyShortfall(args: {
  label: string;
  address: Address;
  wei: bigint;
  maxFeePerGas: bigint;
  usdc: bigint;
  units: bigint;
  fee: bigint;
  /** How the key's USDC there is refilled; the harness key's is a green usdcx-burn-l2 run. */
  refill?: string;
}): string | undefined {
  const head = `top up the key on ${args.label}: ${args.address} holds`;
  const needWei = L2_BRIDGE_IN_GAS * args.maxFeePerGas;
  if (args.wei < needWei) {
    return (
      `${head} ${formatEther(args.wei)} ETH, below the ${formatEther(needWei)} ETH one bridge-in needs ` +
      `(${L2_BRIDGE_IN_GAS} gas at ${formatGwei(args.maxFeePerGas)} gwei); send ${args.label} ETH to ${args.address}`
    );
  }
  const needUsdc = args.units + 2n * args.fee;
  if (args.usdc < needUsdc) {
    const usdc = (units: bigint) => formatUnits(units, CIRCLE_USDC_DECIMALS);
    return (
      `${head} ${usdc(args.usdc)} USDC, below the ${usdc(needUsdc)} USDC one bridge-in needs (the ${usdc(args.units)} ` +
      `deposit and twice Circle's ${usdc(args.fee)} fee, which its approve covers); ` +
      (args.refill ?? "a green usdcx-burn-l2 run refills it with that run's payout")
    );
  }
  return undefined;
}

/**
 * Why Circle cannot pay a burn to `address` on `chain`, or undefined. On Ethereum Sepolia its forwarder sends
 * gatewayMint with a fixed 250,000 gas limit, and a mint to an address that never held Sepolia USDC needs about
 * 346,000, so it reverts on every retry (scripts/e2e-real.mjs probeSepoliaPayoutKey, 2026-10-16).
 */
export function payoutKeyProblem(chain: PayoutChain, address: Address, usdc: bigint): string | undefined {
  if (chain.chainId !== ETHEREUM_SEPOLIA_PAYOUT.chainId || usdc > 0n) return undefined;
  return (
    `${address} holds no ${chain.label} USDC, and Circle's forwarder cannot mint a payout to a recipient with no ` +
    `USDC under its fixed gas limit: fund the key with any amount of ${chain.label} USDC first`
  );
}

export interface L2DepositSubmission {
  /** The endpoint that took the writes; reads of this deposit start there. */
  endpoint: string;
  approveHash?: Hash;
  burnHash: Hash;
  /** The forwarded burn's amount, caller and hook data exactly as the signer received them: what the gates compare. */
  signed: { amount: bigint; destinationCaller: Hex; hookData: Hex };
  /** Every quote the deposit took, in order. */
  quotes: CctpBurnQuote[];
  /** The quote the burn carried: the last one. */
  burnQuote: CctpBurnQuote;
  /** What runUsdcxExecutorDeposit wrote on its `submitting` step, replayed on the wallet's row by the test hook. */
  submitted: { usdcxRemoteRecipient: string; cctp: IUsdcxCctpLeg };
}

/**
 * Deposits `units` from the key on `l2` to the Miden account `recipientHex` through runUsdcxExecutorDeposit. Writes go
 * to one endpoint that takes raw transactions, with a local nonce; reads and receipts fail over. Each send is simulated
 * first; after an approve, the burn's simulation and gas estimate run at the later of the approve's block and the write
 * endpoint's head. Returns once the burn is mined. Nothing more is sent once `signal` is aborted. A key whose USDC does
 * not cover the amount plus the quoted fee is refused by the product before the approve, and again after it before the
 * burn.
 */
export async function submitL2Deposit(
  args: { privateKey: Hex; l2: L2BridgeInSource; units: bigint; recipientHex: string; arc: ArcReadDeps },
  deps: Pick<ArcReadDeps, 'publicClient' | 'clock'> & {
    fetchQuote?: UsdcxExecutorDepositDeps['fetchQuote'];
    isRemoteDomainRegistered?: UsdcxExecutorDepositDeps['isRemoteDomainRegistered'];
  } = {},
  signal?: AbortSignal
): Promise<L2DepositSubmission> {
  const { l2 } = args;
  const reads = l2Reads(l2, { publicClient: deps.publicClient, clock: deps.clock });
  const account = privateKeyToAccount(args.privateKey);
  const remoteRecipient = midenAccountHexToXReserveRecipient(args.recipientHex);
  const amount = formatUnits(args.units, CIRCLE_USDC_DECIMALS);
  const endpoint = await pickWriteEndpoint(reads);
  const endpoints = { write: endpoint, reads: startingAt(reads.endpoints, endpoint) };
  let nonce = await chainRead(`${l2.payout.label} nonce`, endpoints.reads, reads, client =>
    client.getTransactionCount({ address: account.address, blockTag: 'pending' })
  );
  const send = async (what: string, to: Address, data: Hex, atBlock?: bigint): Promise<Hash> => {
    const hash = await sendSigned(reads, endpoints, account, { what, to, data, nonce, atBlock }, signal);
    nonce += 1;
    return hash;
  };
  let approveHash: Hash | undefined;
  // Set once the approve is mined; the burn reads state at it or later (arc-usdcx.ts pinAfterApprove).
  let approveBlock: bigint | undefined;
  // An array, not a `let`: TypeScript keeps a `let` assigned in a callback narrowed to its initial undefined.
  const signedBurns: DepositForBurnWithHookAndFeesArgs[] = [];
  const signer: UsdcxExecutorSigner = {
    approve: async (spender, value) => {
      await simulate('USDC approve', endpoints.write, reads, client =>
        client.simulateContract({
          account: account.address,
          address: l2.source.usdc,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [spender, value]
        })
      );
      approveHash = await send(
        'USDC approve',
        l2.source.usdc,
        encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, value] })
      );
      return approveHash;
    },
    depositForBurnWithHookAndFees: async burn => {
      const atBlock = await pinAfterApprove(endpoints.write, reads, approveBlock);
      await simulate(
        'forwarded burn',
        endpoints.write,
        reads,
        (client, blockNumber) =>
          client.simulateContract({
            account: account.address,
            address: l2.source.tokenMessengerWithFees,
            abi: TOKEN_MESSENGER_WITH_FEES_ABI,
            functionName: 'depositForBurnWithHookAndFees',
            args: burn,
            blockNumber
          }),
        atBlock
      );
      signedBurns.push(burn);
      return send(
        'forwarded burn',
        l2.source.tokenMessengerWithFees,
        encodeFunctionData({
          abi: TOKEN_MESSENGER_WITH_FEES_ABI,
          functionName: 'depositForBurnWithHookAndFees',
          args: burn
        }),
        atBlock
      );
    }
  };
  const quotes: CctpBurnQuote[] = [];
  const fetchQuote = deps.fetchQuote ?? ((intent: ExecutorBurnIntent) => quoteExecutorBurn(l2.source, intent));
  const writes: Array<Parameters<UsdcxExecutorDepositDeps['updatePhase']>> = [];
  const burnHash = await runUsdcxExecutorDeposit('harness-signed', amount, remoteRecipient, {
    source: l2.source,
    depositor: account.address,
    signer,
    isRemoteDomainRegistered:
      deps.isRemoteDomainRegistered ??
      (async domain =>
        domain === (l2.source.midenDomain ?? USDCX_REMOTE_DOMAIN) &&
        readRemoteDomainRegistered(args.arc, l2.source.target.xReserve, domain)),
    readAllowance: spender =>
      chainRead('USDC allowance', endpoints.reads, reads, client =>
        client.readContract({
          address: l2.source.usdc,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [account.address, spender]
        })
      ),
    readBalance: () =>
      chainRead('USDC balance', endpoints.reads, reads, client =>
        client.readContract({
          address: l2.source.usdc,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account.address]
        })
      ),
    waitForReceipt: async hash => {
      const { blockNumber } = await waitForReceipt(endpoints.reads, reads, hash);
      if (hash === approveHash) approveBlock = blockNumber;
    },
    updatePhase: async (...write) => {
      writes.push(write);
    },
    fetchQuote: async intent => {
      const quote = await fetchQuote(intent);
      quotes.push(quote);
      return quote;
    }
  });
  const submitting = writes.find(([, phase, patch]) => phase === 'submitting' && patch?.evmTxHash === burnHash)?.[2];
  const burnQuote = quotes.at(-1);
  const [signedBurn] = signedBurns;
  if (!signedBurn || !submitting?.cctp || submitting.usdcxRemoteRecipient === undefined || !burnQuote) {
    throw new Error(`the deposit ${burnHash} signed no burn, or wrote no forwarded CCTP leg, recipient or quote`);
  }
  const [signedAmount, , , , destinationCaller, hookData] = signedBurn;
  return {
    endpoint,
    approveHash,
    burnHash,
    signed: { amount: signedAmount, destinationCaller, hookData },
    quotes,
    burnQuote,
    submitted: { usdcxRemoteRecipient: submitting.usdcxRemoteRecipient, cctp: submitting.cctp }
  };
}
