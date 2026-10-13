import { IBridgedReceiveExtraInputs, ITransaction } from '../db/types';

/**
 * An executor deposit whose attested message is on the row and not yet executed: it can be executed at any age. Only an
 * executor deposit has a CCTP leg, so the row alone tells; the bridge config, which a realm can be without, is not read.
 */
function holdsExecutableMessage(inputs: IBridgedReceiveExtraInputs): boolean {
  return (
    inputs.provider === 'usdcx' &&
    inputs.phase === 'delivering' &&
    inputs.cctp?.message !== undefined &&
    inputs.cctp.attestation !== undefined &&
    inputs.cctp.executeTxHash === undefined
  );
}

/**
 * When a row's week starts: a ready row's at its attestation, a saved Arc execute's when it was saved and a reverted
 * one's when the revert reopened the leg, so a deposit attested, executed or reverted late in its first week gets a
 * week of its own.
 */
function cutoffStart(row: Pick<ITransaction, 'initiatedAt'>, inputs: IBridgedReceiveExtraInputs): number {
  if (inputs.phase === 'ready') return inputs.readyAt ?? row.initiatedAt;
  const leg = inputs.cctp;
  if (leg?.executeTxHash !== undefined) return leg.executeSavedAt ?? row.initiatedAt;
  return leg?.revertedAt ?? row.initiatedAt;
}

/**
 * Whether the reconciler still tracks an unsettled bridged-receive row, for `cutoffSec` the earliest start an open week
 * can have. It times out a row outside the window, so a delivery may adopt only a row inside it as a live tracker.
 */
export function withinDeliveryWindow(
  row: Pick<ITransaction, 'initiatedAt'>,
  inputs: IBridgedReceiveExtraInputs,
  cutoffSec: number
): boolean {
  return cutoffStart(row, inputs) >= cutoffSec || holdsExecutableMessage(inputs);
}
