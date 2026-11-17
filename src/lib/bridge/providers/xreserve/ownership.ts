import { parseUnits, type Hash, type Hex } from 'viem';

import { assertReviewedBridge } from 'lib/bridge/core/review';
import { configKey } from 'lib/bridge/core/routes';
import type { SubmissionChecks } from 'lib/bridge/core/submission';
import {
  assertBridgeOperationCurrent,
  bridgeOperationOf,
  findAdmittedBridgeOperation,
  recordBridgeSourceAttempt,
  type BridgeOperationSnapshot
} from 'lib/bridge/operation';
import * as Repo from 'lib/miden/repo';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import type { CctpBurnQuote } from 'lib/usdcx/cctp';
import { getUsdcxSourceChain, type UsdcxSourceChain } from 'lib/usdcx/constant';
import { usdcxRemoteRecipientFor } from 'lib/usdcx/deposit-target';

export interface OwnedUsdcxDeposit {
  rowId: string;
  operation: BridgeOperationSnapshot;
  checks: Pick<SubmissionChecks, 'readCurrent' | 'now'>;
}

export function assertUsdcxDepositTerms(
  owned: OwnedUsdcxDeposit,
  trackingTxId: string,
  amount: string,
  recipient: Hex,
  source: UsdcxSourceChain,
  depositor?: string,
  quote?: CctpBurnQuote
): void {
  const { route, accounts, quote: reviewed } = owned.operation.review;
  const chain = route.recovery.config.supportedEvmChains[route.source.network];
  if (
    trackingTxId !== owned.rowId ||
    route.source.kind !== 'erc20' ||
    !reviewed ||
    chain?.chainId !== source.chain.id ||
    configKey(source) !== configKey(getUsdcxSourceChain(source.chain.id)) ||
    parseUnits(amount, 6) !== parseUnits(owned.operation.review.amount, 6) ||
    parseUnits(reviewed.received, route.destination.decimals) !== parseUnits(amount, 6) ||
    recipient.toLowerCase() !== usdcxRemoteRecipientFor(accounts.midenAccount).toLowerCase() ||
    (source.route === 'xreserve'
      ? reviewed.kind !== 'arc-deposit'
      : reviewed.kind !== 'cctp' || depositor?.toLowerCase() !== accounts.evmAddress.toLowerCase())
  )
    throw new Error('Circle source terms changed');
  if (
    quote &&
    (reviewed.kind !== 'cctp' ||
      quote.signedQuote.toLowerCase() !== reviewed.authorization.signedQuote.toLowerCase() ||
      quote.feeTotalAmount !== reviewed.authorization.feeTotalAmount)
  )
    throw new Error('Circle authorization changed');
}

/** Uses only the receive wrapper's original CAS winner, never a reread revision or a second claim. */
export async function assertUsdcxDepositCurrent(owned: OwnedUsdcxDeposit): Promise<void> {
  const { operation, checks } = owned;
  const live = await checks.readCurrent();
  const row = await Repo.transactions.get(owned.rowId);
  const recorded = row && bridgeOperationOf(row);
  if (
    !row ||
    !recorded ||
    recorded.revision !== operation.revision ||
    recorded.sourceAttempt?.phase !== 'running' ||
    row.extraInputs?.phase !== 'submitting' ||
    row.extraInputs.evmTxHash ||
    row.extraInputs.intentNonce
  )
    throw new Error('Circle source ownership changed');
  assertBridgeOperationCurrent(row, operation);
  assertReviewedBridge(operation.review, live, checks.now());
  const current = getBridgeConfigSnapshot();
  const recovery = operation.review.route.recovery;
  if (
    operation.review.route.provider !== 'xreserve' ||
    operation.review.route.mode !== 'receive' ||
    current.status !== 'ready' ||
    configKey([current.network, current.config, current.derived]) !==
      configKey([recovery.network, recovery.config, recovery.derived])
  )
    throw new Error('Circle deposit terms changed');
}

export async function recordCctpSourceFacts(
  owned: OwnedUsdcxDeposit,
  facts: { messageTransmitter?: string; sourceMessage?: Hex }
): Promise<void> {
  await Repo.db.transaction('rw', Repo.transactions, async () => {
    const row = await findAdmittedBridgeOperation(owned.operation);
    const original = row && bridgeOperationOf(row);
    if (
      !row ||
      row.id !== owned.rowId ||
      !original ||
      original.revision !== owned.operation.revision ||
      !original.sourceAttempt
    )
      throw new Error('Circle original receipt ownership changed');
    const previous = row.extraInputs?.cctp;
    if (
      (previous?.messageTransmitter &&
        facts.messageTransmitter &&
        previous.messageTransmitter.toLowerCase() !== facts.messageTransmitter.toLowerCase()) ||
      (previous?.sourceMessage &&
        facts.sourceMessage &&
        previous.sourceMessage.toLowerCase() !== facts.sourceMessage.toLowerCase()) ||
      (facts.sourceMessage &&
        (!original.sourceAttempt.hash || original.sourceAttempt.hash !== row.extraInputs?.evmTxHash))
    )
      throw new Error('Circle original source facts changed');
    const chain = original.review.route.recovery.config.supportedEvmChains[original.review.route.source.network];
    const domain = chain?.bridges.usdcx?.domain;
    if (domain === undefined) throw new Error('Circle original source domain unavailable');
    await Repo.transactions.update(row.id, { 'extraInputs.cctp': { sourceDomain: domain, ...previous, ...facts } });
  });
}

export async function recordUsdcxDepositHash(owned: OwnedUsdcxDeposit, hash: Hash): Promise<void> {
  if (!(await recordBridgeSourceAttempt(owned.operation.operationId, owned.operation.revision, { hash })))
    throw new Error('Circle source identity could not be recorded');
}
