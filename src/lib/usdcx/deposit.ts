import { Address, Hash, Hex, parseUnits } from 'viem';

import { updateBridgedReceivePhase } from 'lib/miden/activity';

import {
  CIRCLE_USDC_DECIMALS,
  getUsdcxContracts,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  USDCX_CHAIN
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

/** Signs and broadcasts the two Arc transactions. The screen supplies the native or wagmi flavour. */
export interface UsdcxSigner {
  approve(spender: Address, value: bigint): Promise<Hash>;
  depositToRemote(args: DepositToRemoteArgs): Promise<Hash>;
}

export interface UsdcxDepositDeps {
  signer: UsdcxSigner;
  isRemoteDomainRegistered(remoteDomain: number): Promise<boolean>;
  /** The USDC allowance the depositing account gave `spender`, in base units. */
  readAllowance(spender: Address): Promise<bigint>;
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
    getUsdcxContracts(USDCX_CHAIN.id).usdc,
    USDCX_DEPOSIT_MAX_FEE,
    USDCX_DEPOSIT_HOOK_DATA
  ];
}

/**
 * Run the EVM leg of a USDCx bridge-in against the tracking row `trackingTxId`.
 *
 * Order: check the remote domain is registered (so an unregistered domain fails
 * before any wallet prompt), read the allowance xReserve has, approve xReserve
 * for the amount and wait for that receipt only when the allowance is less than
 * the amount, call `depositToRemote`, record the hash on the row, wait for the
 * deposit receipt, then move the row to `delivering`. Circle signs the
 * attestation and the relayer mints on Miden after that; nothing here waits
 * for them.
 *
 * Throws on any failure. After broadcast, the caller keeps the row open for
 * background checks unless a receipt confirms that the deposit reverted.
 */
export async function runUsdcxDeposit(
  trackingTxId: string,
  amount: string,
  remoteRecipient: Hex,
  { signer, isRemoteDomainRegistered, readAllowance, waitForReceipt, updatePhase }: UsdcxDepositDeps
): Promise<Hash> {
  const args = buildDepositToRemoteArgs(amount, remoteRecipient);
  const [value, remoteDomain] = args;

  if (!(await isRemoteDomainRegistered(remoteDomain))) {
    throw new UsdcxDomainNotRegisteredError(remoteDomain);
  }

  // An allowance that covers the deposit needs no approval: no second prompt, gas or receipt,
  // and `approve` would replace a larger allowance with this amount.
  const { xReserve } = getUsdcxContracts(USDCX_CHAIN.id);
  if ((await readAllowance(xReserve)) < value) {
    const approvalHash = await signer.approve(xReserve, value);
    await waitForReceipt(approvalHash);
  }

  const depositHash = await signer.depositToRemote(args);
  await updatePhase(trackingTxId, 'submitting', { evmTxHash: depositHash });
  await waitForReceipt(depositHash);
  await updatePhase(trackingTxId, 'delivering', { evmTxHash: depositHash });
  return depositHash;
}
