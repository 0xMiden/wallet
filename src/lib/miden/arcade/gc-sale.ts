import { getBech32AddressFromAccountId, sameWalletAccountId, walletAccountIdToSdk } from 'lib/miden/sdk/helpers';
import {
  GC_SALE_SCRIPT_ROOT,
  listCommittedNoteIdsByTag,
  pswapNoteTag,
  readChainTip,
  readPublicPswapNote,
  type PswapFields
} from 'lib/miden/sdk/pswap-order-note';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { getNativeAssetIdSync } from 'lib/miden-chain/native-asset';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectGcSale } from 'lib/remote-config/values';

import type { GcPurchaseQuote } from '../transaction/initiate';

/**
 * Where a network sells Game Coins: public sale notes offering GC against the chain's fee
 * asset (USDCx). Every fill spends the note and the PSWAP script creates a remainder under a new id with the same
 * tag, so the live note is found by the tag the script derives from the two faucets (`pswapNoteTag`), never by a
 * pinned id (`docs/arcade/gc-integration.md`).
 */
export interface GcSaleConfig {
  /** The GC faucet, hex. */
  gcFaucetId: string;
  /** The configured seller. This config field also controls purchase availability. */
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
/** Maximum USDCx base units per GC. */
export const GC_MAX_PRICE = 1_000n;

/** What the purchase sheet starts at: 1 GC, in base units. */
export const DEFAULT_GC_PURCHASE_AMOUNT = 10n ** BigInt(GC_DECIMALS);

/** Maximum new note bodies read per discovery check. Cached sales are also checked. */
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
 * `arcade.sale.seller` remains in the config scope while `features.arcadeGcPurchase` is on. A document that leaves the switch
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
 * Whether a sale offers the configured GC for the fee asset at an accepted price.
 */
export function isGcSaleNote(fields: PswapFields, sale: GcSaleConfig, payFaucetId: string): boolean {
  return (
    sameWalletAccountId(fields.offeredFaucet, sale.gcFaucetId) &&
    sameWalletAccountId(fields.requestedFaucet, payFaucetId) &&
    fields.offeredAmount > 0n &&
    (fields.storage[2] ?? 0n) > 0n &&
    (fields.storage[2] ?? 0n) * 10n ** BigInt(GC_DECIMALS) <= GC_MAX_PRICE * fields.offeredAmount
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

/** Select the cheapest sale that can supply the amount. Exclude the buyer's own sales. */
export function pickGcSale(sales: GcSale[], gcAmount: bigint, buyer?: string): GcSale | null {
  const eligible = sales.filter(sale => {
    if (buyer && sameWalletAccountId(sale.sellerAccountId, buyer)) return false;
    return 'quote' in quoteGcPurchase(sale, gcAmount);
  });
  eligible.sort((a, b) => {
    const price = a.requestedAmount * b.offeredAmount - b.requestedAmount * a.offeredAmount;
    if (price !== 0n) return price < 0n ? -1 : 1;
    if (a.offeredAmount !== b.offeredAmount) return a.offeredAmount > b.offeredAmount ? -1 : 1;
    return a.saleNoteId.localeCompare(b.saleNoteId);
  });
  return eligible[0] ?? null;
}

interface SaleCandidate {
  noteId: string;
  block: number;
}
interface SaleScan {
  key: string;
  tip: number;
  seen: Set<string>;
  sales: Map<string, GcSale>;
  pending?: Promise<GcSale[]>;
}
let activeScan: SaleScan | undefined;

function scopeKey(network: MIDEN_NETWORK_NAME): string | undefined {
  const sale = getGcSaleConfig(network);
  const pay = getNativeAssetIdSync();
  return sale && pay
    ? JSON.stringify([network, getEffectiveRpcUrl(), sale.sellerAccountId, sale.gcFaucetId, pay, sale.fromBlock])
    : undefined;
}

const candidateOrder = (a: SaleCandidate, b: SaleCandidate): number =>
  b.block - a.block || a.noteId.localeCompare(b.noteId);

/**
 * Read sale notes from the node in bounded batches. Keep progress between checks and recheck each cached sale.
 * A failed read leaves its candidate due for the next check. Config and endpoint changes discard the cache.
 */
export function findGcSales(network: MIDEN_NETWORK_NAME = getEffectiveNetworkName()): Promise<GcSale[]> {
  const key = scopeKey(network);
  if (!key) {
    activeScan = undefined;
    return Promise.resolve([]);
  }
  if (activeScan?.key === key && activeScan.pending) return activeScan.pending;
  if (activeScan?.key !== key) {
    activeScan = { key, tip: -1, seen: new Set(), sales: new Map() };
  }
  const scan = activeScan!;
  const current = () => activeScan === scan && scopeKey(network) === key;
  const work = async (): Promise<GcSale[]> => {
    const sale = getGcSaleConfig(network)!;
    const payFaucetId = getNativeAssetIdSync()!;
    const gcFaucet = walletAccountIdToSdk(sale.gcFaucetId);
    const tag = pswapNoteTag(gcFaucet, walletAccountIdToSdk(payFaucetId));
    const tip = await readChainTip();
    if (!current()) return [];
    if (tip < scan.tip) {
      scan.seen.clear();
      scan.sales.clear();
    }
    scan.tip = tip;
    const committed = await listCommittedNoteIdsByTag(tag, sale.fromBlock, tip);
    if (!current()) return [];
    const ordered = [...committed].sort(candidateOrder);
    const unread = ordered.filter(candidate => !scan.seen.has(candidate.noteId));
    // Alternate new and old candidates so new traffic cannot stop historical discovery.
    const candidates: SaleCandidate[] = [];
    const discoveryLimit = scan.sales.size ? MAX_SALE_NOTE_READS / 2 : MAX_SALE_NOTE_READS;
    while (unread.length && candidates.length < discoveryLimit) {
      const candidate = candidates.length % 2 === 0 ? unread.shift() : unread.pop();
      if (candidate) candidates.push(candidate);
    }
    const checked = new Set<string>();
    const readSale = async (noteId: string) => {
      const read = await readPublicPswapNote(noteId, GC_SALE_SCRIPT_ROOT);
      if (!current()) return;
      checked.add(noteId);
      scan.seen.add(noteId);
      if (read.kind !== 'open' || !isGcSaleNote(read.fields, sale, payFaucetId)) {
        scan.sales.delete(noteId);
        return;
      }
      scan.sales.set(noteId, {
        saleNoteId: noteId,
        sellerAccountId: read.fields.creator,
        payFaucetId,
        gcFaucetId: getBech32AddressFromAccountId(gcFaucet),
        offeredAmount: read.fields.offeredAmount,
        requestedAmount: read.fields.storage[2] ?? 0n,
        fillFloor: read.fields.storage[3] ?? 0n
      });
    };
    for (const candidate of candidates) {
      await readSale(candidate.noteId);
      if (!current()) return [];
    }
    // Recheck cached offers too: a different buyer may have consumed them since the last check.
    for (const noteId of scan.sales.keys()) {
      if (checked.has(noteId)) continue;
      await readSale(noteId);
      if (!current()) return [];
    }
    return [...scan.sales.values()].filter(candidate => checked.has(candidate.saleNoteId));
  };
  const pending = work().finally(() => {
    if (scan.pending === pending) scan.pending = undefined;
  });
  scan.pending = pending;
  return pending;
}

/** The cheapest eligible sale for a purchase, after the current discovery batch. */
export async function findLiveGcSale(
  network: MIDEN_NETWORK_NAME = getEffectiveNetworkName(),
  buyer?: string,
  gcAmount: bigint = DEFAULT_GC_PURCHASE_AMOUNT
): Promise<GcSale | null> {
  return pickGcSale(await findGcSales(network), gcAmount, buyer);
}
