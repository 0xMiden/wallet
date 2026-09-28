import { Address, Hash, Hex, parseUnits } from 'viem';

import { updateBridgedReceivePhase } from 'lib/miden/activity';

import {
  CIRCLE_USDC_DECIMALS,
  CIRCLE_USDC_SEPOLIA_ADDRESS,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_SEPOLIA_ADDRESS
} from './constant';

/** The argument tuple of xReserve `depositToRemote`. */
export type DepositToRemoteArgs = readonly [
  value: bigint,
  remoteDomain: number,
  remoteRecipient: Hex,
  localToken: Address,
  maxFee: bigint,
  hookData: Hex
];

/** Signs and broadcasts the two Sepolia transactions. The screen supplies the native or wagmi flavour. */
export interface UsdcxSigner {
  approve(spender: Address, value: bigint): Promise<Hash>;
  depositToRemote(args: DepositToRemoteArgs): Promise<Hash>;
}

export interface UsdcxDepositDeps {
  signer: UsdcxSigner;
  isRemoteDomainRegistered(remoteDomain: number): Promise<boolean>;
  waitForReceipt(hash: Hash): Promise<void>;
  updatePhase: typeof updateBridgedReceivePhase;
}

/** Circle did not register the remote domain on the xReserve contract. No gas was spent. */
export class UsdcxDomainNotRegisteredError extends Error {
  readonly remoteDomain: number;

  constructor(remoteDomain: number) {
    super(`xReserve remote domain ${remoteDomain} is not registered`);
    this.name = 'UsdcxDomainNotRegisteredError';
    this.remoteDomain = remoteDomain;
  }
}

export function isUsdcxDomainNotRegisteredError(error: unknown): error is UsdcxDomainNotRegisteredError {
  return error instanceof UsdcxDomainNotRegisteredError;
}

/** Build the `depositToRemote` arguments for a human USDC amount and an encoded recipient. */
export function buildDepositToRemoteArgs(amount: string, remoteRecipient: Hex): DepositToRemoteArgs {
  return [
    parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
    USDCX_REMOTE_DOMAIN,
    remoteRecipient,
    CIRCLE_USDC_SEPOLIA_ADDRESS,
    USDCX_DEPOSIT_MAX_FEE,
    USDCX_DEPOSIT_HOOK_DATA
  ];
}

/**
 * Run the EVM leg of a USDCx bridge-in against the tracking row `trackingTxId`.
 *
 * Order: check the remote domain is registered (so an unregistered domain fails
 * before any wallet prompt), approve xReserve for the amount, wait for that
 * receipt, call `depositToRemote`, record the hash on the row, wait for the
 * deposit receipt, then move the row to `delivering`. Circle signs the
 * attestation and the relayer mints on Miden after that; nothing here waits
 * for them.
 *
 * Throws on any failure. The caller marks the row `failed` with the message.
 */
export async function runUsdcxDeposit(
  trackingTxId: string,
  amount: string,
  remoteRecipient: Hex,
  { signer, isRemoteDomainRegistered, waitForReceipt, updatePhase }: UsdcxDepositDeps
): Promise<Hash> {
  const args = buildDepositToRemoteArgs(amount, remoteRecipient);
  const [value, remoteDomain] = args;

  if (!(await isRemoteDomainRegistered(remoteDomain))) {
    throw new UsdcxDomainNotRegisteredError(remoteDomain);
  }

  const approvalHash = await signer.approve(XRESERVE_SEPOLIA_ADDRESS, value);
  await waitForReceipt(approvalHash);

  const depositHash = await signer.depositToRemote(args);
  await updatePhase(trackingTxId, 'submitting', { evmTxHash: depositHash });
  await waitForReceipt(depositHash);
  await updatePhase(trackingTxId, 'delivering', { evmTxHash: depositHash });
  return depositHash;
}
