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

import {
  CCTP_EXECUTOR_HOOK_NAME,
  CCTP_EXECUTOR_PAYLOAD_VERSION,
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
 * The hook data of an executor-route burn: one `circle-generic-executor` frame. No `cctp-forward` frame is
 * added, because Circle's forwarder does not take executor-bound messages yet and the fee entry point
 * refuses a forward hook without a forward fee; the wallet executes the message on Arc itself.
 */
export function encodeExecutorHookData(
  target: UsdcxExecutorTarget,
  remoteRecipient: Hex,
  recoveryAddress: Address
): Hex {
  return encodeHookFrame(CCTP_EXECUTOR_HOOK_NAME, encodeExecutorPayload(target, remoteRecipient, recoveryAddress));
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
 * Build the burn for a human USDC amount: a standard transfer to Arc that mints to the executor and binds the
 * executor as its destination caller, which `TransportUtils.validateExecutorHookBinding` requires.
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
    encodeExecutorHookData(source.target, remoteRecipient, recoveryAddress)
  ];
}

/** Signs and broadcasts the two source-chain transactions. The screen supplies the native or wagmi flavour. */
export interface UsdcxExecutorSigner {
  approve(spender: Address, value: bigint): Promise<Hash>;
  depositForBurnWithHook(args: DepositForBurnWithHookArgs): Promise<Hash>;
}

export interface UsdcxExecutorDepositDeps {
  source: UsdcxExecutorSource;
  /** The depositor; recorded as the executor payload's recovery address. */
  depositor: Address;
  signer: UsdcxExecutorSigner;
  /** Whether Arc's xReserve has Miden registered; read on Arc, where the deposit lands. */
  isRemoteDomainRegistered(remoteDomain: number): Promise<boolean>;
  /** The source USDC allowance the depositor gave `spender`, in base units. */
  readAllowance(spender: Address): Promise<bigint>;
  waitForReceipt(hash: Hash): Promise<void>;
  updatePhase: typeof updateBridgedReceivePhase;
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
 * execution after the burn), read the allowance the token messenger has, approve it for the amount and
 * wait for that receipt only when the allowance is less than the amount, burn, record the hash on the row,
 * wait for the burn receipt, then move the row to `delivering`. The CCTP leg is then Circle's to attest and
 * the wallet's to execute on Arc (`runUsdcxExecute`); nothing here waits for them.
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
    updatePhase
  }: UsdcxExecutorDepositDeps
): Promise<Hash> {
  const args = buildDepositForBurnWithHookArgs(amount, source, remoteRecipient, depositor);
  const [value] = args;

  if (!(await isRemoteDomainRegistered(USDCX_REMOTE_DOMAIN))) {
    throw new UsdcxExecutorDomainNotRegisteredError(USDCX_REMOTE_DOMAIN);
  }

  if ((await readAllowance(source.tokenMessenger)) < value) {
    const approvalHash = await signer.approve(source.tokenMessenger, value);
    await waitForReceipt(approvalHash);
  }

  const burnHash = await signer.depositForBurnWithHook(args);
  await updatePhase(trackingTxId, 'submitting', { evmTxHash: burnHash, cctp: { sourceDomain: source.domain } });
  await waitForReceipt(burnHash);
  await updatePhase(trackingTxId, 'delivering', { evmTxHash: burnHash });
  return burnHash;
}
