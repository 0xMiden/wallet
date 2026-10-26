import { getBech32AddressFromAccountId, sameWalletAccountId, walletAccountIdToSdk } from 'lib/miden/sdk/helpers';
import {
  listCommittedNoteIdsByTag,
  pswapNoteTag,
  readChainTip,
  readPublicPswapNote,
  type PswapFields
} from 'lib/miden/sdk/pswap-order-note';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectGcSale } from 'lib/remote-config/values';

import type { GcPurchaseQuote } from '../transaction/initiate';

/**
 * Where a network sells Game Coins: one public PSWAP note the seller created, offering GC against the chain's fee
 * asset (USDCx). Every fill spends the note and the PSWAP script creates a remainder under a new id with the same
 * tag, so the live note is found by the tag the script derives from the two faucets (`pswapNoteTag`), never by a
 * pinned id (`docs/arcade/gc-integration.md`).
 */
export interface GcSaleConfig {
  /** The GC faucet, hex. */
  gcFaucetId: string;
  /** The account whose storage the sale note names as creator; a note of any other creator is not this sale. */
  sellerAccountId: string;
  /** The first block a note of the sale can be in, so the tag walk starts there. */
  fromBlock: number;
}

/**
 * The bundled sale per network: what a wallet with no accepted config document uses, as `GUARDIAN_OPTIONS` is for
 * the operators. Mainnet only: the sale `scripts/dev/gc-sale/buy.mjs` filled on 2026-10-26, 0.001 USDCx per GC.
 */
export const GC_SALES: Partial<Record<MIDEN_NETWORK_NAME, GcSaleConfig>> = {
  [MIDEN_NETWORK_NAME.MAINNET]: {
    gcFaucetId: '0x34a3510213533f512ec4abe36baf84',
    sellerAccountId: '0xa6be5c4d8fdc03415bde66453d5f91',
    fromBlock: 214_000
  }
};

export const GC_DECIMALS = 6;

/** What the purchase sheet starts at: 1 GC, in base units. */
export const DEFAULT_GC_PURCHASE_AMOUNT = 10n ** BigInt(GC_DECIMALS);

/** Sale notes whose bodies one `findLiveGcSale` reads before it gives up; a lineage has one live note. */
const MAX_SALE_NOTE_READS = 8;

/** The live sale note as the node holds it, with the terms a quote needs. */
export interface GcSale {
  saleNoteId: string;
  sellerAccountId: string;
  /** The pay faucet (USDCx), as the wallet names it. */
  payFaucetId: string;
  /** The GC faucet, bech32, as balance rows name it. */
  gcFaucetId: string;
  /** GC left in the note, in base units. */
  offeredAmount: bigint;
  /** USDCx the note still asks for all of it, in base units: the price is `requestedAmount / offeredAmount`. */
  requestedAmount: bigint;
  /** The smallest fill the note takes, in USDCx base units (`ERR_PSWAP_FILL_BELOW_MINIMUM`). */
  fillFloor: bigint;
}

/**
 * The sale of `network`, or undefined where there is none. The accepted config document decides: its
 * `arcade.sale.seller` is the seller while `features.arcadeGcPurchase` is on, and a document that leaves the switch
 * off turns the purchase off. With no accepted document for the network (a first start that cannot reach the config
 * repo, a read before the realm hydrated) the bundled sale stands in, as the bundled operator list does.
 */
export function getGcSaleConfig(network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()): GcSaleConfig | undefined {
  const bundled = GC_SALES[network];
  if (!bundled) return undefined;
  const snapshot = getBridgeConfigSnapshot();
  if (snapshot.network !== network || snapshot.config === null) return bundled;
  const sale = selectGcSale(snapshot);
  return sale ? { ...bundled, sellerAccountId: sale.seller } : undefined;
}

/**
 * What one fill of `fillAmount` buys from a PSWAP note by the script's arithmetic (miden-standards 0.17.1
 * `pswap.masm`, `calculate_output_amount` with the whole fill on the account leg): floor(offered × fill ÷ requested),
 * or the whole offer when the fill meets the request. Undefined for a fill the note refuses: below its fill floor
 * (`ERR_PSWAP_FILL_BELOW_MINIMUM`), zero, or above its request, which the SDK's builder rejects.
 */
export function pswapFillPayout(
  fields: Pick<PswapFields, 'offeredAmount' | 'storage'>,
  fillAmount: bigint
): bigint | undefined {
  const requested = fields.storage[2] ?? 0n;
  const fillFloor = fields.storage[3] ?? 0n;
  if (fillAmount < 1n || requested < 1n || fillAmount > requested) return undefined;
  if (fillAmount < (fillFloor < requested ? fillFloor : requested)) return undefined;
  return fillAmount === requested ? fields.offeredAmount : (fields.offeredAmount * fillAmount) / requested;
}

/**
 * Whether a PSWAP note is `sale`'s: the seller created it and it offers GC against the network's fee asset. A note of
 * another creator or pair under the same tag is somebody else's sale.
 */
export function isGcSaleNote(fields: PswapFields, sale: GcSaleConfig, payFaucetId: string): boolean {
  return (
    sameWalletAccountId(fields.creator, sale.sellerAccountId) &&
    sameWalletAccountId(fields.offeredFaucet, sale.gcFaucetId) &&
    sameWalletAccountId(fields.requestedFaucet, payFaucetId)
  );
}

/** Why a GC amount cannot be bought from the live note. */
export type GcQuoteRefusal = 'zero' | 'above_inventory' | 'below_fill_floor';

/**
 * The fill that buys `gcAmount` from `sale`, and what it delivers. The cost is rounded up (ceil(gc × requested ÷
 * offered), as GQ's shop prices it), so the script's floor pays out at least `gcAmount`; a fill that meets the whole
 * request takes the whole offer. Refused for no GC, more GC than the note holds, or a cost under the note's fill
 * floor. `expectedAmount` is what the row records and completion keeps, so the receipt never overstates the buy.
 */
export function quoteGcPurchase(
  sale: GcSale,
  gcAmount: bigint
): { quote: GcPurchaseQuote } | { refusal: GcQuoteRefusal } {
  if (gcAmount < 1n) return { refusal: 'zero' };
  if (gcAmount > sale.offeredAmount) return { refusal: 'above_inventory' };
  const fillAmount = (gcAmount * sale.requestedAmount + sale.offeredAmount - 1n) / sale.offeredAmount;
  const expectedAmount = pswapFillPayout(
    { offeredAmount: sale.offeredAmount, storage: [0n, 0n, sale.requestedAmount, sale.fillFloor] },
    fillAmount
  );
  if (expectedAmount === undefined) return { refusal: 'below_fill_floor' };
  return {
    quote: {
      saleNoteId: sale.saleNoteId,
      sellerAccountId: sale.sellerAccountId,
      payFaucetId: sale.payFaucetId,
      fillAmount,
      gcFaucetId: sale.gcFaucetId,
      expectedAmount
    }
  };
}

/**
 * The live sale note of this network, on RPC clients of its own and no WASM lock: the notes under the sale's tag
 * newest first, the first unspent one of the seller's with GC left. Null when the network has no sale, the fee asset
 * is not discovered yet, or no note is open; a failed node read rejects.
 */
export async function findLiveGcSale(network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()): Promise<GcSale | null> {
  const sale = getGcSaleConfig(network);
  const payFaucetId = getNativeAssetIdSync();
  if (!sale || !payFaucetId) return null;
  const gcFaucet = walletAccountIdToSdk(sale.gcFaucetId);
  const tag = pswapNoteTag(gcFaucet, walletAccountIdToSdk(payFaucetId));
  const tip = await readChainTip();
  const committed = await listCommittedNoteIdsByTag(tag, sale.fromBlock, tip);
  for (const { noteId } of committed.slice(0, MAX_SALE_NOTE_READS)) {
    const read = await readPublicPswapNote(noteId);
    if (read.kind !== 'open' || !isGcSaleNote(read.fields, sale, payFaucetId)) continue;
    const requestedAmount = read.fields.storage[2] ?? 0n;
    if (read.fields.offeredAmount < 1n || requestedAmount < 1n) continue;
    return {
      saleNoteId: noteId,
      sellerAccountId: sale.sellerAccountId,
      payFaucetId,
      gcFaucetId: getBech32AddressFromAccountId(gcFaucet),
      offeredAmount: read.fields.offeredAmount,
      requestedAmount,
      fillFloor: read.fields.storage[3] ?? 0n
    };
  }
  return null;
}
