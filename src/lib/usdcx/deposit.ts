import { Address, Hash, Hex, parseUnits } from 'viem';

import type { OwnedUsdcxDeposit } from 'lib/bridge/providers/xreserve/ownership';
import { updateBridgedReceivePhase } from 'lib/miden/activity';

import {
  CIRCLE_USDC_DECIMALS,
  getUsdcxXReserveSource,
  UsdcxXReserveSource,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  getUsdcxRemoteDomain
} from './constant';
import { UsdcxDomainNotRegisteredError } from './protocol';

export { isUsdcxDomainNotRegisteredError, UsdcxDomainNotRegisteredError } from './protocol';

/** The argument tuple of xReserve `depositToRemote`. */
export type DepositToRemoteArgs = readonly [
  value: bigint,
  remoteDomain: number,
  remoteRecipient: Hex,
  localToken: Address,
  maxFee: bigint,
  hookData: Hex
];

/** Signs and broadcasts the two source-chain transactions. The screen supplies the native or wagmi flavour. */
export interface UsdcxSigner {
  approve(spender: Address, value: bigint): Promise<Hash>;
  depositToRemote(args: DepositToRemoteArgs): Promise<Hash>;
}

export interface UsdcxDepositDeps {
  /** The EVM chain the deposit is made on; it must be a `usdcxSourceChains` entry with a local xReserve. */
  sourceChainId: number;
  source?: UsdcxXReserveSource;
  signer: UsdcxSigner;
  isRemoteDomainRegistered(remoteDomain: number): Promise<boolean>;
  /** The USDC allowance the depositing account gave `spender`, in base units. */
  readAllowance(spender: Address): Promise<bigint>;
  waitForReceipt(hash: Hash): Promise<void>;
  updatePhase: typeof updateBridgedReceivePhase;
  owned?: OwnedUsdcxDeposit;
}

/** Build the `depositToRemote` arguments for a human USDC amount, an encoded recipient and a source chain. */
export function buildDepositToRemoteArgs(
  amount: string,
  remoteRecipient: Hex,
  sourceChainId: number,
  source = getUsdcxXReserveSource(sourceChainId)
): DepositToRemoteArgs {
  return [
    parseUnits(amount.trim(), CIRCLE_USDC_DECIMALS),
    source.midenDomain ?? getUsdcxRemoteDomain(),
    remoteRecipient,
    source.usdc,
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
 * the amount, call `depositToRemote`, record the hash and the signed recipient on the row, wait for the
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
  {
    sourceChainId,
    source = getUsdcxXReserveSource(sourceChainId),
    signer,
    isRemoteDomainRegistered,
    readAllowance,
    waitForReceipt,
    updatePhase,
    owned
  }: UsdcxDepositDeps
): Promise<Hash> {
  const original = owned && { ...owned, operation: structuredClone(owned.operation) };
  const ownership = original && await import('lib/bridge/providers/xreserve/ownership');
  const assertCurrent = async () => { if (original && ownership) await ownership.assertUsdcxDepositCurrent(original); };
  if (original && ownership) ownership.assertUsdcxDepositTerms(original, trackingTxId, amount, remoteRecipient, source);
  await assertCurrent();
  const args = buildDepositToRemoteArgs(amount, remoteRecipient, sourceChainId, source);
  const [value, remoteDomain] = args;

  if (!(await isRemoteDomainRegistered(remoteDomain))) {
    throw new UsdcxDomainNotRegisteredError(remoteDomain);
  }

  // An allowance that covers the deposit needs no approval: no second prompt, gas or receipt,
  // and `approve` would replace a larger allowance with this amount.
  const { xReserve } = source;
  if ((await readAllowance(xReserve)) < value) {
    await assertCurrent();
    const approvalHash = await signer.approve(xReserve, value);
    await waitForReceipt(approvalHash);
  }

  await assertCurrent();
  const depositHash = await signer.depositToRemote(args);
  if (original && ownership) await ownership.recordUsdcxDepositHash(original, depositHash);
  await updatePhase(trackingTxId, 'submitting', {
    evmTxHash: depositHash,
    usdcxRemoteRecipient: remoteRecipient.toLowerCase()
  });
  await waitForReceipt(depositHash);
  await updatePhase(trackingTxId, 'delivering', { evmTxHash: depositHash });
  return depositHash;
}
