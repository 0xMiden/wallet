import {
  Address,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  Hash,
  Hex,
  isAddress,
  padHex,
  parseUnits,
  stringToHex,
  toHex
} from 'viem';

import type { updateBridgedReceivePhase } from 'lib/miden/activity';
import { walletRaised } from 'lib/telemetry/bridge-receive-failure';

import { CctpBurnQuote, fetchCctpBurnQuote } from './cctp';
import type { UsdcxExecutorSource, UsdcxExecutorTarget } from './constant';
import {
  CCTP_EXECUTOR_HOOK_NAME,
  CCTP_EXECUTOR_PAYLOAD_VERSION,
  CCTP_FORWARD_HOOK_NAME,
  CCTP_HOOK_VERSION,
  CIRCLE_USDC_DECIMALS,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  UsdcxDomainNotRegisteredError,
  XRESERVE_ABI
} from './protocol';

// The live L2 bridge-in suite runs this module in Node (playwright/e2e/helpers/usdcx-l2-deposit.ts), so nothing here may
// load the wallet's configuration runtime or the SDK at runtime; usdcx-node-imports.test.ts fails on either.

/** The route's Miden domain. Every route usdcxSourceChains builds has one: schema.ts drops a usdcx route without it. */
function midenDomainOf(route: { midenDomain?: number }): number {
  if (route.midenDomain === undefined) throw walletRaised(new Error('USDCx Miden domain is not configured'));
  return route.midenDomain;
}

/** `depositToRemote(value, ...)`: the amount is the first argument, right after the 4-byte selector. */
const DEPOSIT_AMOUNT_CALLDATA_INDEX = 4n;

/**
 * One composable hook frame: a 24-byte name, a uint32 version and a uint32 payload length, then the payload.
 * This is the layout `ComposableHookData._findHook` scans on Arc and Circle's forwarding service documents.
 */
export function encodeHookFrame(name: string, payload: Hex): Hex {
  const nameHex = stringToHex(name);
  if (nameHex.length > 2 + 48) throw walletRaised(new Error(`Hook name ${name} is longer than 24 bytes`));
  const payloadLength = (payload.length - 2) / 2;
  return concatHex([
    padHex(nameHex, { size: 24, dir: 'right' }),
    toHex(CCTP_HOOK_VERSION, { size: 4 }),
    toHex(payloadLength, { size: 4 }),
    payload
  ]);
}

/** An EVM address as the right-aligned bytes32 CCTP uses for recipients and callers. */
export function addressToBytes32(address: Address): Hex {
  return padHex(address, { size: 32 });
}

/**
 * The calldata Circle's DepositFor handler sends Arc's xReserve: `depositToRemote` for Miden and the Miden
 * recipient, with a zero amount the handler overwrites with the amount the executor minted.
 */
export function encodeXReserveDepositCalldata(target: UsdcxExecutorTarget, remoteRecipient: Hex): Hex {
  return encodeFunctionData({
    abi: XRESERVE_ABI,
    functionName: 'depositToRemote',
    args: [0n, midenDomainOf(target), remoteRecipient, target.usdc, USDCX_DEPOSIT_MAX_FEE, USDCX_DEPOSIT_HOOK_DATA]
  });
}

/**
 * The handler's `data`: `abi.encode(depositContract, approvalTarget, depositCalldata, amountIndices)` as
 * `DepositForHandler.handle` decodes it. xReserve pulls the deposit from its caller, so it is both the
 * contract called and the approval target, and the one amount index points at `value`.
 */
export function encodeDepositForHandlerData(target: UsdcxExecutorTarget, remoteRecipient: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'bytes' }, { type: 'uint256[]' }],
    [
      target.xReserve,
      target.xReserve,
      encodeXReserveDepositCalldata(target, remoteRecipient),
      [DEPOSIT_AMOUNT_CALLDATA_INDEX]
    ]
  );
}

/**
 * The executor hook's payload: `abi.encode(version, recoveryAddress, handler, handlerCalldata)` as
 * `GenericExecutor._decodeAndValidatePayload` decodes it. The executor only passes `recoveryAddress`
 * through to the handler; the wallet records the depositor there.
 */
export function encodeExecutorPayload(
  target: UsdcxExecutorTarget,
  remoteRecipient: Hex,
  recoveryAddress: Address
): Hex {
  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes' }],
    [
      CCTP_EXECUTOR_PAYLOAD_VERSION,
      addressToBytes32(recoveryAddress),
      target.handler,
      encodeDepositForHandlerData(target, remoteRecipient)
    ]
  );
}

/**
 * The hook data of an executor-route burn: an empty `cctp-forward` frame ahead of the `circle-generic-executor`
 * frame. The forward frame is what Circle's forwarder looks for; the fee entry point refuses a forward hook
 * without a forward fee and a forward fee without the hook, so every burn carries both the frame and a signed
 * quote. The executor ignores the forward frame on Arc.
 */
export function encodeExecutorHookData(
  target: UsdcxExecutorTarget,
  remoteRecipient: Hex,
  recoveryAddress: Address
): Hex {
  const executorFrame = encodeHookFrame(
    CCTP_EXECUTOR_HOOK_NAME,
    encodeExecutorPayload(target, remoteRecipient, recoveryAddress)
  );
  return concatHex([encodeHookFrame(CCTP_FORWARD_HOOK_NAME, '0x'), executorFrame]);
}

/**
 * Circle did not sign a quote the burn can use: the quote request was refused or could not be made, or the fee
 * of the second quote is more than the one approval covers. The burn is not sent; the user can try again.
 */
export class UsdcxForwardQuoteUnavailableError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Circle did not quote the forwarded burn: ${reason}`, options);
    this.name = 'UsdcxForwardQuoteUnavailableError';
    walletRaised(this);
  }
}

export function isUsdcxForwardQuoteUnavailableError(error: unknown): error is UsdcxForwardQuoteUnavailableError {
  return error instanceof UsdcxForwardQuoteUnavailableError;
}

/**
 * The source USDC balance does not cover the amount plus Circle's quoted fee, which the burn pulls on top of the
 * amount. Raised before any prompt, or after a paid approval when the balance read after it falls short, but always
 * before the burn prompt. All three values are in base units.
 */
export class UsdcxExecutorBalanceTooLowError extends Error {
  readonly needed: bigint;
  readonly fee: bigint;
  readonly balance: bigint;

  constructor(needed: bigint, fee: bigint, balance: bigint) {
    super(`The burn needs ${needed} USDC base units, the amount plus a fee of ${fee}, but the balance is ${balance}`);
    this.name = 'UsdcxExecutorBalanceTooLowError';
    this.needed = needed;
    this.fee = fee;
    this.balance = balance;
    walletRaised(this);
  }
}

export function isUsdcxExecutorBalanceTooLowError(error: unknown): error is UsdcxExecutorBalanceTooLowError {
  return error instanceof UsdcxExecutorBalanceTooLowError;
}

/** What a burn of `value` plus Circle's `fee` needs from `balance`, all in base units. */
export interface UsdcxExecutorFeeShortfall {
  needed: bigint;
  fee: bigint;
  balance: bigint;
}

/** The shortfall when `balance` does not cover `value` plus the fee the burn pulls on top of it, else undefined. */
export function usdcxExecutorFeeShortfall(
  value: bigint,
  fee: bigint,
  balance: bigint
): UsdcxExecutorFeeShortfall | undefined {
  const needed = value + fee;
  return balance < needed ? { needed, fee, balance } : undefined;
}

/** The argument tuple of `TokenMessengerWithFees.depositForBurnWithHookAndFees`. */
export type DepositForBurnWithHookAndFeesArgs = readonly [
  amount: bigint,
  destinationDomain: number,
  mintRecipient: Hex,
  burnToken: Address,
  destinationCaller: Hex,
  hookData: Hex,
  claim: { signedQuote: Hex; refundAddress: Address }
];

/** The values a quote is bound to, built once so the quote and the burn cannot disagree. */
export interface ExecutorBurnIntent {
  value: bigint;
  destinationCaller: Hex;
  hookData: Hex;
}

/** The forwarded burn's intent for a human USDC amount: the executor as caller and the forwarded hook data. */
export function buildExecutorBurnIntent(
  amount: string,
  source: UsdcxExecutorSource,
  remoteRecipient: Hex,
  recoveryAddress: Address
): ExecutorBurnIntent {
  if (!isAddress(recoveryAddress)) throw walletRaised(new Error(`Invalid EVM address: ${recoveryAddress}`));
  return {
    value: parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
    destinationCaller: addressToBytes32(source.target.executor),
    hookData: encodeExecutorHookData(source.target, remoteRecipient, recoveryAddress)
  };
}

/**
 * Ask Circle to price the forwarded burn: the forward fee that pays Circle to execute on Arc, and the fast
 * fee so the burn is attested before source finality. Throws when Circle refuses or cannot be reached.
 */
export function quoteExecutorBurn(source: UsdcxExecutorSource, intent: ExecutorBurnIntent): Promise<CctpBurnQuote> {
  return fetchCctpBurnQuote(source.domain, source.target.domain, {
    baseUrl: source.irisApi,
    amount: intent.value,
    feeToken: source.usdc,
    destinationCaller: intent.destinationCaller,
    hookData: intent.hookData,
    fast: true
  });
}

/** Build the forwarded burn from its intent and the quote Circle signed for it. */
export function buildDepositForBurnWithHookAndFeesArgs(
  source: UsdcxExecutorSource,
  intent: ExecutorBurnIntent,
  quote: CctpBurnQuote,
  refundAddress: Address
): DepositForBurnWithHookAndFeesArgs {
  return [
    intent.value,
    source.target.domain,
    intent.destinationCaller,
    source.usdc,
    intent.destinationCaller,
    intent.hookData,
    { signedQuote: quote.signedQuote, refundAddress }
  ];
}

/** Signs and broadcasts the source-chain transactions. The screen supplies the native or wagmi flavour. */
export interface UsdcxExecutorSigner {
  approve(spender: Address, value: bigint): Promise<Hash>;
  /** The forwarded burn, through the fee entry point. */
  depositForBurnWithHookAndFees(args: DepositForBurnWithHookAndFeesArgs): Promise<Hash>;
}

export interface UsdcxExecutorDepositDeps {
  source: UsdcxExecutorSource;
  /** The depositor; recorded as the executor payload's recovery address and the quote's refund address. */
  depositor: Address;
  signer: UsdcxExecutorSigner;
  /** Whether Arc's xReserve has Miden registered; read on Arc, where the deposit lands. */
  isRemoteDomainRegistered(remoteDomain: number): Promise<boolean>;
  /** The source USDC allowance the depositor gave `spender`, in base units. */
  readAllowance(spender: Address): Promise<bigint>;
  /** The depositor's source USDC balance, in base units; read before the first quote and again after an approval. */
  readBalance(): Promise<bigint>;
  waitForReceipt(hash: Hash): Promise<void>;
  updatePhase: typeof updateBridgedReceivePhase;
  /** Circle's quote for the forwarded burn; `quoteExecutorBurn` unless a test supplies one. */
  fetchQuote?: (intent: ExecutorBurnIntent) => Promise<CctpBurnQuote>;
}

/**
 * Run the source-chain leg of an executor-route bridge-in against the tracking row `trackingTxId`.
 *
 * Order: check Arc's xReserve has Miden registered (the executor would otherwise revert the whole execution
 * after the burn), read the fee entry point's allowance and the balance, ask Circle for a quote, then approve and
 * burn. The burn goes through the fee entry point for the amount plus the fee and Circle forwards and executes it on
 * Arc. When Circle refuses or cannot be reached, the deposit fails with `UsdcxForwardQuoteUnavailableError` before
 * any wallet prompt, since a burn through the plain token messenger is not forwarded and would stop at the executor.
 * A balance short of the amount plus the quoted fee fails it with `UsdcxExecutorBalanceTooLowError`, also before any
 * prompt. The approval is sent only when the allowance is short, the hash and the signed recipient are recorded on
 * the row before the receipt is awaited, and the row then moves to `delivering`.
 * Nothing here waits for Circle. A quote lives about two minutes, so after an approval the burn signs a second
 * quote; the approval covers twice the quoted fee, and a fee beyond that fails the deposit the same way. The
 * approval wait can outlast the balance read too, so the balance is read again once the approval confirms, before the
 * second quote, and a balance short of the second fee fails the deposit after the paid approval with
 * `UsdcxExecutorBalanceTooLowError`, before the burn prompt.
 */
export async function runUsdcxExecutorDeposit(
  trackingTxId: string,
  amount: string,
  remoteRecipient: Hex,
  {
    source,
    depositor,
    signer,
    isRemoteDomainRegistered,
    readAllowance,
    readBalance,
    waitForReceipt,
    updatePhase,
    fetchQuote = intent => quoteExecutorBurn(source, intent)
  }: UsdcxExecutorDepositDeps
): Promise<Hash> {
  const intent = buildExecutorBurnIntent(amount, source, remoteRecipient, depositor);

  const remoteDomain = midenDomainOf(source);
  if (!(await isRemoteDomainRegistered(remoteDomain))) {
    throw new UsdcxDomainNotRegisteredError(remoteDomain);
  }

  const quoteOrFail = async (): Promise<CctpBurnQuote> => {
    try {
      return await fetchQuote(intent);
    } catch (error) {
      throw new UsdcxForwardQuoteUnavailableError('the quote request failed', { cause: error });
    }
  };

  // The allowance and the balance are read before the quote, so after a quote only an approval (followed by a balance
  // read and a second quote), the signer's bounded fee read and the burn prompt remain. The balance is read here, not
  // taken from the caller, because the caller's chain switch before this can wait on the user. At most one approval
  // goes to the fee entry point, for twice the quoted fee so a fee that moved by the second quote is still covered; a
  // fee beyond that, or no second quote, fails the deposit before the burn prompt. The approval prompt and its receipt
  // can take minutes too, so the balance is read again after them, before the second quote.
  const feeAllowance = await readAllowance(source.tokenMessengerWithFees);
  const balance = await readBalance();
  const ensureBalanceCovers = ({ feeTotalAmount }: CctpBurnQuote, held: bigint) => {
    const shortfall = usdcxExecutorFeeShortfall(intent.value, feeTotalAmount, held);
    if (shortfall) throw new UsdcxExecutorBalanceTooLowError(shortfall.needed, shortfall.fee, shortfall.balance);
  };
  let quote = await quoteOrFail();
  ensureBalanceCovers(quote, balance);
  await updatePhase(
    trackingTxId,
    'submitting',
    {
      cctp: { sourceDomain: source.domain, forwarded: true, forwardFee: quote.feeTotalAmount.toString() }
    },
    undefined,
    { claimSourceExecution: { provider: 'usdcx', source, recipient: remoteRecipient } }
  );
  if (feeAllowance < intent.value + quote.feeTotalAmount) {
    const approvedSpend = intent.value + 2n * quote.feeTotalAmount;
    await waitForReceipt(await signer.approve(source.tokenMessengerWithFees, approvedSpend));
    const freshBalance = await readBalance();
    quote = await quoteOrFail();
    ensureBalanceCovers(quote, freshBalance);
    if (intent.value + quote.feeTotalAmount > approvedSpend) {
      throw new UsdcxForwardQuoteUnavailableError('the fee of the second quote is more than the approval covers');
    }
  }

  await updatePhase(
    trackingTxId,
    'submitting',
    {
      cctp: { sourceDomain: source.domain, forwarded: true, forwardFee: quote.feeTotalAmount.toString() }
    },
    undefined,
    { continueSourceExecution: { provider: 'usdcx', source, recipient: remoteRecipient } }
  );
  const burnHash = await signer.depositForBurnWithHookAndFees(
    buildDepositForBurnWithHookAndFeesArgs(source, intent, quote, depositor)
  );
  await updatePhase(trackingTxId, 'submitting', {
    evmTxHash: burnHash,
    usdcxRemoteRecipient: remoteRecipient.toLowerCase(),
    cctp: { sourceDomain: source.domain, forwarded: true, forwardFee: quote.feeTotalAmount.toString() }
  });
  await waitForReceipt(burnHash);
  await updatePhase(trackingTxId, 'delivering', { evmTxHash: burnHash });
  return burnHash;
}
