import { Address, Hash, Hex } from 'viem';

import { parseArcAmount } from 'lib/bridge/providers/xreserve/deposit-terms';
import type { OwnedUsdcxDeposit } from 'lib/bridge/providers/xreserve/ownership';
import { updateBridgedReceivePhase } from 'lib/miden/activity';

import {
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

/** An approval of `value` USDC base units to `spender`. */
export interface UsdcxApproval {
  spender: Address;
  value: bigint;
}

/** What the row records with the deposit hash: the recipient that the deposit signed, in lower case. */
export interface UsdcxDepositFacts {
  usdcxRemoteRecipient: string;
}

/** Signs and broadcasts the source-chain transactions. The screen supplies the native, wagmi or relay flavour. */
export interface UsdcxSigner {
  approve(spender: Address, value: bigint): Promise<Hash>;
  depositToRemote(args: DepositToRemoteArgs): Promise<Hash>;
  /**
   * Optional. Sends the approval and the deposit as one atomic unit: both execute, or neither, so no receipt wait
   * comes between them. When it is set, the deposit uses it and never `approve` or `depositToRemote`. `approval` is
   * null when the allowance covers the deposit. `facts` is what the row records with the deposit hash: the signer gets
   * it before it sends, so it can record a reference to the send with these facts first.
   */
  approveAndDepositToRemote?(
    approval: UsdcxApproval | null,
    args: DepositToRemoteArgs,
    facts: UsdcxDepositFacts
  ): Promise<Hash>;
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
    parseArcAmount(amount),
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
 * deposit receipt, then move the row to `delivering`. A batch signer sends the approval (when it is necessary) and
 * the deposit as one atomic unit, with no approval receipt wait. Circle signs the
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
  const ownership = original && (await import('lib/bridge/providers/xreserve/ownership'));
  const assertCurrent = async () => {
    if (original && ownership) await ownership.assertUsdcxDepositCurrent(original);
  };
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
  const needsApproval = (await readAllowance(xReserve)) < value;
  const facts: UsdcxDepositFacts = { usdcxRemoteRecipient: remoteRecipient.toLowerCase() };

  let depositHash: Hash;
  if (signer.approveAndDepositToRemote !== undefined) {
    // One atomic unit: the deposit cannot run without its approval, so no approval receipt is awaited.
    await assertCurrent();
    const approval = needsApproval ? { spender: xReserve, value } : null;
    depositHash = await signer.approveAndDepositToRemote(approval, args, facts);
  } else {
    if (needsApproval) {
      await assertCurrent();
      const approvalHash = await signer.approve(xReserve, value);
      await waitForReceipt(approvalHash);
    }
    await assertCurrent();
    depositHash = await signer.depositToRemote(args);
  }
  if (original && ownership) await ownership.recordUsdcxDepositHash(original, depositHash);
  await updatePhase(trackingTxId, 'submitting', { evmTxHash: depositHash, ...facts });
  await waitForReceipt(depositHash);
  await updatePhase(trackingTxId, 'delivering', { evmTxHash: depositHash });
  return depositHash;
}
