import type { MidenClient } from '@miden-sdk/miden-sdk/lazy';

import {
  netOutflowByFaucet,
  simulatedBytesToView,
  simulatedOutputRecipients,
  type AssetAmount,
  type NftAsset,
  type TxAssetView
} from 'app/confirm/decode';
import { dryRunPreparedCustomRequest, type CustomDryRunBytes } from 'lib/miden/sdk/custom-dry-run';
import { accountRefToSdk, canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import { hasSpendingLimits } from 'lib/miden/spending-limits/queue';
import { spendsDigest } from 'lib/miden/spending-limits/types';

import { CustomTransactionEffectsChangedError } from './constants';
import type { IApprovedCustomEffects, IConsumedAssetTotal, ICustomTransactionEffects } from '../db/types';

/*
 * The rule for a dApp custom (`execute`) transaction:
 *
 * 1. The user approves the effects of a dry run, never the effects that the dApp declares. The approval needs a
 *    dry run that succeeds. The wallet records the approved effects on the queued row.
 * 2. At generation, the wallet does a dry run of the prepared request again and compares its effects with the
 *    approved effects. The wallet proposes the request only when the two are equal.
 * 3. The spending-limit charge comes from the generation-time effects. They must give the same spends as the row's
 *    `spentAssetTotals`, which the admission valued and which a spending-limit authorization binds.
 *
 * Two cases fail by design:
 * - A request that the wallet cannot simulate at approval. The wallet refuses it before any prompt.
 * - A request whose effects change between approval and generation. The row fails before the proposal, with
 *   `CustomTransactionEffectsChangedError`, and nothing moves.
 */

/** The dry-run bytes that the effects come from. One of the two fields is set. */
export interface CustomDryRunResult {
  summaryBytes?: string;
  executedBytes?: string;
}

/** The provenance facts that the approval dry run records. See `SimulateCustomTxResult`. */
export interface CustomDryRunProvenance {
  introducedCredit?: readonly AssetAmount[];
  introducedCount?: number;
}

/** The view of a dry run and the effects that the wallet compares. */
interface DecodedCustomEffects {
  view: TxAssetView;
  effects: ICustomTransactionEffects;
}

/** The effects of an approval dry run, and the spends that the spending-limit policy charges for them. */
export interface ApprovedCustomSimulation {
  view: TxAssetView;
  effects: IApprovedCustomEffects;
  /** Undefined when the policy cannot attribute the value (see `customEffectSpends`). */
  spends?: IConsumedAssetTotal[];
}

/** One entry for each canonical faucet, sorted by faucet. The same faucet in two spellings becomes one entry. */
function foldByFaucet(assets: readonly AssetAmount[]): IConsumedAssetTotal[] {
  const totals = new Map<string, bigint>();
  for (const asset of assets) {
    const faucetId = canonicalWalletAccountId(asset.faucetId);
    totals.set(faucetId, (totals.get(faucetId) ?? 0n) + asset.amount);
  }
  return [...totals.keys()].sort().map(faucetId => ({ faucetId, amount: totals.get(faucetId) ?? 0n }));
}

function nftKeys(nfts: readonly NftAsset[]): string[] {
  return nfts.map(nft => `${canonicalWalletAccountId(nft.faucetId)}|${nft.assetId}`).sort();
}

/** Decodes a dry run with the same ladder on both sides. `undefined` when the dry run gave neither result. */
function decodeCustomEffects(dryRun: CustomDryRunResult): DecodedCustomEffects | undefined {
  const view = simulatedBytesToView(dryRun);
  const recipients = simulatedOutputRecipients(dryRun);
  if (view === undefined || recipients === undefined) return undefined;
  const fee =
    view.fee === undefined
      ? undefined
      : { faucetId: canonicalWalletAccountId(view.fee.faucetId), amount: view.fee.amount };
  return {
    view,
    effects: {
      shape: dryRun.summaryBytes ? 'summary' : 'executed',
      outgoing: foldByFaucet(view.outgoing),
      incoming: foldByFaucet(view.incoming),
      outgoingNfts: nftKeys(view.outgoingNfts),
      incomingNfts: nftKeys(view.incomingNfts),
      unlistedAssets: view.unlistedAssets,
      recipients,
      inputNotesConsumed: view.inputNotesConsumed,
      outputNotesCreated: view.outputNotesCreated,
      ...(fee === undefined ? {} : { fee }),
      storageChanged: view.storageChanged
    }
  };
}

/**
 * Per-faucet value that leaves the account, for the spending-limit policy, or `undefined` when the policy cannot
 * attribute it.
 *
 * The summary result reports a NETTED vault delta with no note identity, so it has already credited every consumed
 * note, also the notes that the wallet already held. When the request consumed more notes than it introduced, that
 * figure understates the outflow and the policy must not use it. The executed result reports note flows, so its
 * value is always attributable. The charge is the NET outflow after the credit of the notes that the request
 * introduced, and of no other notes.
 */
export function customEffectSpends(
  view: TxAssetView,
  shape: ICustomTransactionEffects['shape'],
  provenance: CustomDryRunProvenance
): IConsumedAssetTotal[] | undefined {
  const attributable = shape === 'executed' || view.inputNotesConsumed <= (provenance.introducedCount ?? 0);
  if (!attributable) return undefined;
  return netOutflowByFaucet(view, provenance.introducedCredit ?? []).map(asset => ({
    faucetId: asset.faucetId,
    amount: asset.amount
  }));
}

/**
 * The effects that the user approves for an approval dry run, or `undefined` when the dry run gave no result. The
 * caller refuses the request before any prompt when this is `undefined`.
 */
export function approveCustomSimulation(
  dryRun: CustomDryRunResult & CustomDryRunProvenance
): ApprovedCustomSimulation | undefined {
  const decoded = decodeCustomEffects(dryRun);
  if (decoded === undefined) return undefined;
  return {
    view: decoded.view,
    effects: {
      ...decoded.effects,
      introducedCredit: foldByFaucet(dryRun.introducedCredit ?? []),
      introducedCount: dryRun.introducedCount ?? 0
    },
    spends: customEffectSpends(decoded.view, decoded.effects.shape, dryRun)
  };
}

const EFFECT_FIELDS = [
  'shape',
  'outgoing',
  'incoming',
  'outgoingNfts',
  'incomingNfts',
  'unlistedAssets',
  'recipients',
  'inputNotesConsumed',
  'outputNotesCreated',
  'fee',
  'storageChanged'
] as const;

type EffectField = (typeof EFFECT_FIELDS)[number];

const totalsText = (totals: readonly IConsumedAssetTotal[]): string =>
  totals.map(total => `${total.faucetId}:${total.amount.toString()}`).join('|');

function fieldText(effects: ICustomTransactionEffects, field: EffectField): string {
  switch (field) {
    case 'outgoing':
    case 'incoming':
      return totalsText(effects[field]);
    case 'outgoingNfts':
    case 'incomingNfts':
    case 'recipients':
      return effects[field].join('|');
    case 'unlistedAssets':
    case 'inputNotesConsumed':
    case 'outputNotesCreated':
      return effects[field].toString();
    case 'fee':
      return effects.fee === undefined ? '' : totalsText([effects.fee]);
    case 'storageChanged':
      return effects.storageChanged ? 'true' : 'false';
    case 'shape':
      return effects.shape;
  }
}

/** The first field that is not equal, or `undefined` when the effects are equal. */
export function customEffectsDifference(
  approved: ICustomTransactionEffects,
  generated: ICustomTransactionEffects
): EffectField | undefined {
  return EFFECT_FIELDS.find(field => fieldText(approved, field) !== fieldText(generated, field));
}

/**
 * Compares a generation-time dry run with the approved effects of an `execute` row, and refuses with
 * `CustomTransactionEffectsChangedError` on any difference.
 *
 * The spends that the generation-time effects give must also have the same digest as the row's `spentAssetTotals`:
 * the admission charged those spends and a spending-limit authorization binds their digest, so the charge is the
 * generation-time value. The approval provenance (`introducedCredit`, `introducedCount`) comes from the approved
 * record, because the approval dry run imported those notes and the wallet cannot identify them again.
 *
 * An unattributable generation spend (`undefined`) is not an empty list. When `spendingLimitConfigured` is set it
 * refuses. The argument defaults to no limit, so a comparison that does not know the policy still matches an
 * uncharged row, whether the stored charge is unset or an empty list.
 */
export function assertCustomEffectsApproved(
  approved: IApprovedCustomEffects | undefined,
  dryRun: CustomDryRunResult,
  spentAssetTotals: readonly IConsumedAssetTotal[] | undefined,
  spendingLimitConfigured = false
): void {
  if (approved === undefined) {
    throw new CustomTransactionEffectsChangedError('the row has no approved effects');
  }
  const decoded = decodeCustomEffects(dryRun);
  if (decoded === undefined) {
    throw new CustomTransactionEffectsChangedError('the generation dry run gave no effects');
  }
  const difference = customEffectsDifference(approved, decoded.effects);
  if (difference !== undefined) {
    throw new CustomTransactionEffectsChangedError(difference);
  }
  const spends = customEffectSpends(decoded.view, decoded.effects.shape, approved);
  if (spends === undefined && spendingLimitConfigured) {
    throw new CustomTransactionEffectsChangedError('spentAssetTotals');
  }
  if (spendsDigest(spends ?? []) !== spendsDigest(spentAssetTotals ?? [])) {
    throw new CustomTransactionEffectsChangedError('spentAssetTotals');
  }
}

/** How the effects check reaches the WASM client: its dry run, and the check that the caller still owns the hold. */
export interface CustomEffectsCheckAccess {
  /** The account the prepared request executes for. The effects check reads its spending limit. */
  accountId: string;
  /** Does the generation-time dry run of the prepared bytes. */
  dryRun: () => Promise<CustomDryRunBytes>;
  /** Throws when the caller's hold is no longer current. `where` names the transition for the log. */
  assertHoldCurrent: (where: string) => void;
}

/**
 * The client access of the effects check for a caller that holds the WASM client lock. The dry run uses that
 * client and that hold, so the hold is checked after each of its awaits.
 */
export function customEffectsCheckAccess(
  client: MidenClient,
  accountId: string,
  preparedBytes: Uint8Array,
  hold: WasmLockHold
): CustomEffectsCheckAccess {
  return {
    accountId,
    dryRun: () => dryRunPreparedCustomRequest(client, accountRefToSdk(accountId).toString(), preparedBytes, hold),
    assertHoldCurrent: where => assertWasmHoldCurrent(hold, where)
  };
}

/**
 * Does the generation-time dry run of a prepared `execute` request and compares it with the approved effects.
 * Refuses with `CustomTransactionEffectsChangedError` on any difference, before the caller proposes anything.
 *
 * The caller holds the WASM client lock (see `customEffectsCheckAccess`). The decode is in the same hold, so a trap in
 * it reaches the lock. The account closed over by that access is the one whose spending limit decides whether an
 * unattributable generation spend can match an uncharged row.
 */
export async function verifyPreparedCustomRequest(
  access: CustomEffectsCheckAccess,
  approved: IApprovedCustomEffects | undefined,
  spentAssetTotals: readonly IConsumedAssetTotal[] | undefined
): Promise<void> {
  access.assertHoldCurrent('before the custom request effects check');
  const dryRun = await access.dryRun();
  access.assertHoldCurrent('after the custom request effects dry run');
  const spendingLimitConfigured = await hasSpendingLimits(access.accountId);
  assertCustomEffectsApproved(approved, dryRun, spentAssetTotals, spendingLimitConfigured);
}
