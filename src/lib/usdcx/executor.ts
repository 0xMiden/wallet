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

import { updateBridgedReceivePhase } from 'lib/miden/activity';

import { CctpBurnQuote, fetchCctpBurnQuote } from './cctp';
import {
  CCTP_EXECUTOR_HOOK_NAME,
  CCTP_EXECUTOR_PAYLOAD_VERSION,
  CCTP_FORWARD_HOOK_NAME,
  CCTP_HOOK_VERSION,
  CCTP_STANDARD_FINALITY_THRESHOLD,
  CIRCLE_USDC_DECIMALS,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  UsdcxExecutorSource,
  UsdcxExecutorTarget,
  XRESERVE_ABI
} from './constant';

/** `depositToRemote(value, ...)`: the amount is the first argument, right after the 4-byte selector. */
const DEPOSIT_AMOUNT_CALLDATA_INDEX = 4n;

/**
 * One composable hook frame: a 24-byte name, a uint32 version and a uint32 payload length, then the payload.
 * This is the layout `ComposableHookData._findHook` scans on Arc and Circle's forwarding service documents.
 */
export function encodeHookFrame(name: string, payload: Hex): Hex {
  const nameHex = stringToHex(name);
  if (nameHex.length > 2 + 48) throw new Error(`Hook name ${name} is longer than 24 bytes`);
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
    args: [0n, USDCX_REMOTE_DOMAIN, remoteRecipient, target.usdc, USDCX_DEPOSIT_MAX_FEE, USDCX_DEPOSIT_HOOK_DATA]
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
 * The hook data of an executor-route burn. A forwarded burn (one with a signed quote) carries an empty
 * `cctp-forward` frame ahead of the `circle-generic-executor` frame, which is what Circle's forwarder looks
 * for; the fee entry point refuses a forward hook without a forward fee and a forward fee without the hook,
 * so the frame is present exactly when the quote is. The executor ignores the forward frame on Arc.
 */
export function encodeExecutorHookData(
  target: UsdcxExecutorTarget,
  remoteRecipient: Hex,
  recoveryAddress: Address,
  { forward }: { forward: boolean }
): Hex {
  const executorFrame = encodeHookFrame(
    CCTP_EXECUTOR_HOOK_NAME,
    encodeExecutorPayload(target, remoteRecipient, recoveryAddress)
  );
  return forward ? concatHex([encodeHookFrame(CCTP_FORWARD_HOOK_NAME, '0x'), executorFrame]) : executorFrame;
}

/** The argument tuple of `TokenMessengerV2.depositForBurnWithHook`. */
export type DepositForBurnWithHookArgs = readonly [
  amount: bigint,
  destinationDomain: number,
  mintRecipient: Hex,
  burnToken: Address,
  destinationCaller: Hex,
  maxFee: bigint,
  minFinalityThreshold: number,
  hookData: Hex
];

/**
 * Build the manual burn for a human USDC amount: a standard transfer to Arc that mints to the executor and
 * binds the executor as its destination caller, which `TransportUtils.validateExecutorHookBinding` requires.
 * The wallet executes this message on Arc itself.
 */
export function buildDepositForBurnWithHookArgs(
  amount: string,
  source: UsdcxExecutorSource,
  remoteRecipient: Hex,
  recoveryAddress: Address
): DepositForBurnWithHookArgs {
  if (!isAddress(recoveryAddress)) throw new Error(`Invalid EVM address: ${recoveryAddress}`);
  const executor = addressToBytes32(source.target.executor);
  return [
    parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
    source.target.domain,
    executor,
    source.usdc,
    executor,
    0n,
    CCTP_STANDARD_FINALITY_THRESHOLD,
    encodeExecutorHookData(source.target, remoteRecipient, recoveryAddress, { forward: false })
  ];
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
  if (!isAddress(recoveryAddress)) throw new Error(`Invalid EVM address: ${recoveryAddress}`);
  return {
    value: parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
    destinationCaller: addressToBytes32(source.target.executor),
    hookData: encodeExecutorHookData(source.target, remoteRecipient, recoveryAddress, { forward: true })
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
  /** The manual burn, through the plain token messenger. */
  depositForBurnWithHook(args: DepositForBurnWithHookArgs): Promise<Hash>;
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
  waitForReceipt(hash: Hash): Promise<void>;
  updatePhase: typeof updateBridgedReceivePhase;
  /** Circle's quote for the forwarded burn; `quoteExecutorBurn` unless a test supplies one. */
  fetchQuote?: (intent: ExecutorBurnIntent) => Promise<CctpBurnQuote>;
}

/** Circle did not register the remote domain on Arc's xReserve. No gas was spent. */
export class UsdcxExecutorDomainNotRegisteredError extends Error {
  readonly remoteDomain: number;

  constructor(remoteDomain: number) {
    super(`Arc xReserve remote domain ${remoteDomain} is not registered`);
    this.name = 'UsdcxExecutorDomainNotRegisteredError';
    this.remoteDomain = remoteDomain;
  }
}

export function isUsdcxExecutorDomainNotRegisteredError(
  error: unknown
): error is UsdcxExecutorDomainNotRegisteredError {
  return error instanceof UsdcxExecutorDomainNotRegisteredError;
}

/**
 * Run the source-chain leg of an executor-route bridge-in against the tracking row `trackingTxId`.
 *
 * Order: check Arc's xReserve has Miden registered (the executor would otherwise revert the whole
 * execution after the burn), ask Circle for a quote, then approve and burn. With a quote the burn goes
 * through the fee entry point for the amount plus the fee and Circle forwards and executes it on Arc;
 * when Circle refuses or cannot be reached the burn goes through the plain token messenger for the amount
 * and the wallet executes it on Arc itself. Either way the approval is sent only when the allowance is
 * short, the hash is recorded on the row before the receipt is awaited, and the row then moves to
 * `delivering`. Nothing here waits for Circle.
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
    waitForReceipt,
    updatePhase,
    fetchQuote = intent => quoteExecutorBurn(source, intent)
  }: UsdcxExecutorDepositDeps
): Promise<Hash> {
  const intent = buildExecutorBurnIntent(amount, source, remoteRecipient, depositor);

  if (!(await isRemoteDomainRegistered(USDCX_REMOTE_DOMAIN))) {
    throw new UsdcxExecutorDomainNotRegisteredError(USDCX_REMOTE_DOMAIN);
  }

  let quote: CctpBurnQuote | undefined;
  try {
    quote = await fetchQuote(intent);
  } catch (error) {
    console.warn('[usdcx] Circle did not quote the forwarded burn; the wallet will execute on Arc', error);
  }

  const spender = quote ? source.tokenMessengerWithFees : source.tokenMessenger;
  const spend = quote ? intent.value + quote.feeTotalAmount : intent.value;
  if ((await readAllowance(spender)) < spend) {
    const approvalHash = await signer.approve(spender, spend);
    await waitForReceipt(approvalHash);
  }

  const burnHash = quote
    ? await signer.depositForBurnWithHookAndFees(
        buildDepositForBurnWithHookAndFeesArgs(source, intent, quote, depositor)
      )
    : await signer.depositForBurnWithHook(buildDepositForBurnWithHookArgs(amount, source, remoteRecipient, depositor));
  await updatePhase(trackingTxId, 'submitting', {
    evmTxHash: burnHash,
    cctp: quote
      ? { sourceDomain: source.domain, forwarded: true, forwardFee: quote.feeTotalAmount.toString() }
      : { sourceDomain: source.domain, forwarded: false }
  });
  await waitForReceipt(burnHash);
  await updatePhase(trackingTxId, 'delivering', { evmTxHash: burnHash });
  return burnHash;
}
