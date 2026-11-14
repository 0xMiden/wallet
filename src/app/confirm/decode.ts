import { FungibleAsset, NonFungibleAsset, TransactionResult, TransactionSummary } from '@miden-sdk/miden-sdk/lazy';

import { splitExecutedOutputNotes } from 'lib/miden/activity/fee-notes';
import { canonicalWalletAccountId, getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { nftKey, toNft, type NftAsset } from 'lib/miden/sdk/nft-asset';
import { b64ToU8 } from 'lib/shared/helpers';

export type { NftAsset };

/**
 * An NFT as a decoded view lists it: what the sheet shows, plus `key`, the complete identity (`nftKey`: faucet and the
 * whole value word) that the short `assetId` cannot give. The signing-time check matches approved NFTs by `key` only.
 */
export type ViewNft = NftAsset & { key?: string };

export interface AssetAmount {
  faucetId: string;
  amount: bigint;
}

/** One note a verified transaction consumes or creates. `opaque` when its assets cannot be read (amounts and nfts are then empty). */
export interface ViewNote {
  id: string;
  amounts: AssetAmount[];
  nfts: ViewNft[];
  opaque?: true;
}

export interface TxAssetView {
  /** Bech32 account address; only known on the verified (executed) path. */
  account?: string;
  /** Assets leaving the account (created output notes / removed vault assets). */
  outgoing: AssetAmount[];
  /** Assets entering the account (consumed notes / added vault assets). */
  incoming: AssetAmount[];
  /** NFTs leaving the account, from the notes created; a vault change no note explains is in `unlistedAssets`. */
  outgoingNfts: ViewNft[];
  /** NFTs entering the account, from the notes consumed. */
  incomingNfts: ViewNft[];
  /**
   * Vault changes the view cannot list. The summary path reads a vault delta whose non-fungible side the SDK does
   * not expose, so it counts them instead: `numAssets()` less the fungible entries it did list. Non-zero must be
   * shown as a warning, never as "no assets move".
   */
  unlistedAssets: number;
  inputNotesConsumed: number;
  /** User-created notes only. The kernel's fee note is reported in `fee`, not counted here. */
  outputNotesCreated: number;
  /**
   * The network fee this transaction pays, when it is knowable from what was decoded.
   *
   * Kept OUT of `outgoing` ON BOTH PATHS, which is what makes the two comparable: the
   * executed path never adds the fee note to the total, and the summary path subtracts it
   * back out of the account delta (see `withoutFee`). Without that symmetry the same request
   * rendered a transfer-plus-fee row for one account kind and a transfer-only row for
   * another, through one renderer under one "verified" label.
   *
   * It is a real cost and belongs on the sheet — labelled as a fee, beside the transfer,
   * never inside it. Rendered by `TransactionAssetView` and by `formatAssetViewRows`.
   */
  fee?: AssetAmount;
  storageChanged: boolean;
  /** Every input note, with its id. Set by the verified builders only. */
  viewConsumedNotes?: ViewNote[];
  /** User-created notes with their ids; the fee note is excluded. Set by the verified builders only. */
  createdNotes?: ViewNote[];
  /** How many consumed notes the account already held. Set only by {@link toHoldingsView}. */
  heldNotesSpent?: number;
}

function toAmounts(assets: FungibleAsset[]): AssetAmount[] {
  // Token metadata is cached under the BECH32 faucet address (see
  // fetchTokenMetadata's `Address.fromBech32` and how balances/claimable-notes
  // populate it via getBech32AddressFromAccountId). Using AccountId.toString()
  // (hex) here misses that cache, so getTokenMetadata falls back to Miden's
  // metadata and mislabels non-Miden assets (e.g. 0.05 BTC → "-5 Miden").
  return assets.map(a => ({ faucetId: getBech32AddressFromAccountId(a.faucetId()), amount: a.amount() }));
}

type NoteWithAssets = {
  assets(): { fungibleAssets(): any[]; nonFungibleAssets(): NonFungibleAsset[] } | undefined;
};

function noteAssets(note: NoteWithAssets | undefined): AssetAmount[] {
  const na = note?.assets();
  return na ? toAmounts(na.fungibleAssets()) : [];
}

function noteNftAssets(note: NoteWithAssets | undefined): NonFungibleAsset[] {
  return note?.assets()?.nonFungibleAssets() ?? [];
}

type NoteId = { id(): { toString(): string } };

const idOf = (note: NoteId): string => note.id().toString().toLowerCase();

function viewNoteOf(id: string, note: NoteWithAssets | undefined): ViewNote {
  if (!note?.assets()) return { id, amounts: [], nfts: [], opaque: true };
  return { id, amounts: noteAssets(note), nfts: noteNfts(note) };
}

const viewNft = (asset: NonFungibleAsset): ViewNft => ({ ...toNft(asset), key: nftKey(asset) });

function noteNfts(note: NoteWithAssets | undefined): ViewNft[] {
  return noteNftAssets(note).map(viewNft);
}

/**
 * The NFTs a summary's NET vault delta moves. One consumed into a created note never touches the vault, so it
 * appears on neither side, exactly as a fungible amount that nets to zero does.
 */
function netNfts(
  created: NonFungibleAsset[],
  consumed: NonFungibleAsset[]
): { leaving: ViewNft[]; entering: ViewNft[] } {
  const createdKeys = new Set(created.map(nftKey));
  const consumedKeys = new Set(consumed.map(nftKey));
  return {
    leaving: created.filter(nft => !consumedKeys.has(nftKey(nft))).map(viewNft),
    entering: consumed.filter(nft => !createdKeys.has(nftKey(nft))).map(viewNft)
  };
}

/**
 * The summary path's incoming/outgoing with the fee taken back out of the account delta.
 *
 * Only the SUMMARY path needs this. Its totals come from the account DELTA — a NET vault
 * change with the fee already withdrawn inside it — while the executed path builds its
 * totals from note flows and never included the fee at all. Reporting the fee separately
 * while leaving it folded into the delta would show it twice.
 *
 * Done on the SIGNED net, not on the removed side alone, because the fee faucet can land on
 * either side of the delta. An account that consumes a 10-native note and pays a 2 fee nets
 * +8 RECEIVED; subtracting only from removals leaves that as `incoming: 8` while the
 * executed path calls the same transaction `incoming: 10, fee: 2`. Adding the fee back to
 * the signed value and re-deciding the direction makes the two agree: -2 + 2 = 0 for a plain
 * send, +8 + 2 = +10 for that consume. A component that nets to zero is dropped rather than
 * emitted at 0, so a fee-only transaction reads as moving nothing rather than sending 0.
 */
function reconcileFee(
  added: AssetAmount[],
  removed: AssetAmount[],
  fee: AssetAmount | undefined
): { incoming: AssetAmount[]; outgoing: AssetAmount[] } {
  if (!fee) return { incoming: added, outgoing: removed };
  const signed = new Map<string, bigint>();
  for (const a of added) signed.set(a.faucetId, (signed.get(a.faucetId) ?? 0n) + a.amount);
  for (const a of removed) signed.set(a.faucetId, (signed.get(a.faucetId) ?? 0n) - a.amount);
  signed.set(fee.faucetId, (signed.get(fee.faucetId) ?? 0n) + fee.amount);

  const incoming: AssetAmount[] = [];
  const outgoing: AssetAmount[] = [];
  for (const [faucetId, amount] of signed) {
    if (amount > 0n) incoming.push({ faucetId, amount });
    else if (amount < 0n) outgoing.push({ faucetId, amount: -amount });
  }
  return { incoming, outgoing };
}

/** Ground-truth view from an executed TransactionSummary (authoritative). */
export function summaryToView(ts: TransactionSummary): TxAssetView {
  const delta = ts.accountDelta();
  const vault = delta.vault();
  // `fee::pay_fee` runs INSIDE the auth procedure, before the summary is built, so the
  // kernel's fee note is among the summary's output notes exactly as it is among an
  // executed transaction's. Counting it claimed a note the user did not create.
  const { feeNote, userNotes } = splitExecutedOutputNotes(ts);
  const fee = (feeNote ? noteAssets(feeNote) : [])[0];
  const added = vault.addedFungibleAssets();
  const removed = vault.removedFungibleAssets();
  const { incoming, outgoing } = reconcileFee(toAmounts(added), toAmounts(removed), fee);
  const inputNotes = ts.inputNotes();
  const { leaving, entering } = netNfts(
    userNotes.flatMap(note => noteNftAssets(note)),
    inputNotes.notes().flatMap(note => noteNftAssets(note.note()))
  );
  return {
    account: getBech32AddressFromAccountId(delta.id()),
    outgoing,
    incoming,
    outgoingNfts: leaving,
    incomingNfts: entering,
    // The SDK exposes the vault delta's NFT side only as a count. One delta entry per faucet makes the fungible
    // entries the two lists' lengths together, and the NFTs read from the notes are the entries it explains.
    unlistedAssets: Math.max(0, vault.numAssets() - added.length - removed.length - leaving.length - entering.length),
    inputNotesConsumed: inputNotes.numNotes(),
    outputNotesCreated: userNotes.length,
    fee,
    storageChanged: !delta.storage().isEmpty(),
    viewConsumedNotes: inputNotes.notes().map(input => viewNoteOf(idOf(input), input.note())),
    createdNotes: userNotes.map(created => viewNoteOf(idOf(created), created))
  };
}

/**
 * The view for a dry-run result, whichever ground-truth shape it produced.
 *
 * `summaryBytes` and `executedBytes` are mutually exclusive and the account decides which: a
 * summary exists only while authorization is still pending (a guardian/multisig account below its
 * threshold), and every ordinary single-sig account on the 0.16 line takes the executed path
 * instead. `undefined` means the dry run produced neither, i.e. the effects are genuinely unknown.
 *
 * Exists so that ladder is written ONCE. It was previously inline in the confirm screen and absent
 * from the backend, and a backend consumer that decoded only the summary shape silently treated
 * every ordinary account as unsimulatable.
 */
export function simulatedBytesToView(result: {
  summaryBytes?: string;
  executedBytes?: string;
}): TxAssetView | undefined {
  if (result.summaryBytes) return summaryBytesToView(result.summaryBytes);
  if (result.executedBytes) return executedBytesToView(result.executedBytes);
  return undefined;
}

/**
 * The recipient digest of each note that a dry run creates for the user, sorted. The fee note is not included.
 *
 * Uses the same ladder and the same fee-note split as `simulatedBytesToView`, so the approval dry run and the
 * generation dry run of a custom request decode their recipients identically. `undefined` means the dry run gave
 * neither result.
 */
export function simulatedOutputRecipients(result: {
  summaryBytes?: string;
  executedBytes?: string;
}): string[] | undefined {
  if (result.summaryBytes) {
    return userNoteRecipients(TransactionSummary.deserialize(b64ToU8(result.summaryBytes)));
  }
  if (result.executedBytes) {
    return userNoteRecipients(TransactionResult.deserialize(b64ToU8(result.executedBytes)).executedTransaction());
  }
  return undefined;
}

function userNoteRecipients(source: Parameters<typeof splitExecutedOutputNotes>[0]): string[] {
  return splitExecutedOutputNotes(source)
    .userNotes.map(note => note.recipientDigest().toHex())
    .sort();
}

/**
 * Per-faucet value leaving the account: the view's `outgoing`, never reduced by what it consumed. `incoming` counts
 * every consumed note, including ones the user already held, and crediting those let a dApp consume a pending 1000
 * of the user's and send 1050 while only 50 was charged. A caller that must credit the notes a request brought in
 * measures a holdings view ({@link toHoldingsView}) instead.
 *
 * ONE ENTRY PER CANONICAL FAUCET. The executed view flat-maps over output notes, so two notes on
 * one faucet arrive as two entries, and the same faucet can arrive under two spellings. Both
 * consumers downstream assess each entry independently, so 60 and 60 would each pass a cap of 100.
 * Folding here rather than at either consumer is what keeps the number the user is shown and the
 * number the queue enforces the same one.
 */
export function netOutflowByFaucet(view: TxAssetView): AssetAmount[] {
  const signed = new Map<string, bigint>();
  for (const asset of view.outgoing) {
    const key = canonicalWalletAccountId(asset.faucetId);
    signed.set(key, (signed.get(key) ?? 0n) + asset.amount);
  }
  const outflow: AssetAmount[] = [];
  for (const [faucetId, amount] of signed) if (amount > 0n) outflow.push({ faucetId, amount });
  return outflow;
}

/**
 * The view re-measured from the account's holdings: what leaves is what the account gives up, counting a consumed note
 * it already held as value it spends. A consumed note counts as brought in only when `introducedNoteIds` names it.
 *
 * Per canonical faucet, `signed = outgoing - incoming + held`, where `held` sums the consumed notes the request did
 * not introduce. The summary view's `outgoing` is the vault's net change and the executed view's is the gross output
 * notes, and this formula gives both the same answer. Positive goes to `outgoing`, negative (negated) to `incoming`.
 * A held note whose assets cannot be read cannot be measured, so the call throws; an introduced one is credited
 * nothing, which can only overstate what leaves.
 * NFTs follow the same rule: one created from an introduced note passes through, any other created NFT leaves.
 */
export function toHoldingsView(view: TxAssetView, introducedNoteIds: readonly string[]): TxAssetView {
  const consumed = view.viewConsumedNotes;
  const created = view.createdNotes;
  if (!consumed || !created) throw new Error('the view does not list its notes');
  const introduced = new Set(introducedNoteIds.map(id => id.toLowerCase()));
  const held = consumed.filter(note => !introduced.has(note.id));
  const carried = consumed.filter(note => introduced.has(note.id));
  if (held.some(note => note.opaque)) throw new Error('a held note does not list its assets');

  const signed = new Map<string, bigint>();
  const spelling = new Map<string, string>();
  const add = (faucetId: string, amount: bigint) => {
    const key = canonicalWalletAccountId(faucetId);
    if (!spelling.has(key)) spelling.set(key, faucetId);
    signed.set(key, (signed.get(key) ?? 0n) + amount);
  };
  for (const asset of view.outgoing) add(asset.faucetId, asset.amount);
  for (const asset of view.incoming) add(asset.faucetId, -asset.amount);
  for (const note of held) for (const asset of note.amounts) add(asset.faucetId, asset.amount);

  const outgoing: AssetAmount[] = [];
  const incoming: AssetAmount[] = [];
  for (const [key, amount] of signed) {
    const faucetId = spelling.get(key) ?? key;
    if (amount > 0n) outgoing.push({ faucetId, amount });
    else if (amount < 0n) incoming.push({ faucetId, amount: -amount });
  }

  const carriedKeys = new Set(carried.flatMap(note => note.nfts.map(nft => nft.key)));
  const createdKeys = new Set(created.flatMap(note => note.nfts.map(nft => nft.key)));
  return {
    ...view,
    outgoing,
    incoming,
    outgoingNfts: created.flatMap(note => note.nfts).filter(nft => nft.key === undefined || !carriedKeys.has(nft.key)),
    incomingNfts: carried.flatMap(note => note.nfts).filter(nft => nft.key === undefined || !createdKeys.has(nft.key)),
    heldNotesSpent: held.length
  };
}

export function summaryBytesToView(summaryB64: string): TxAssetView {
  return summaryToView(TransactionSummary.deserialize(b64ToU8(summaryB64)));
}

/**
 * Ground-truth view from a locally EXECUTED transaction (authoritative), used
 * when the account was already fully authorized so execution produced no
 * TransactionSummary — every ordinary single-sig account on web-sdk 0.16, where
 * `executeForSummary` rejects with `TRANSACTION_ALREADY_AUTHORIZED` (see
 * `lib/miden/back/simulate-custom-tx.ts`).
 *
 * Assets come from the notes the execution actually consumed and created, not
 * from the account delta: 0.16's `ExecutedTransaction.accountPatch()` is
 * ABSOLUTE (final balances, `AccountVaultPatch.updatedFungibleAssets()`), so it
 * cannot be read as an incoming/outgoing delta without the pre-state. Note flows
 * are the same quantities the summary view reports for the transactions this
 * screen previews.
 */
export function executedBytesToView(executedB64: string): TxAssetView {
  const executed = TransactionResult.deserialize(b64ToU8(executedB64)).executedTransaction();
  const inputNotes = executed.inputNotes();
  // The kernel's fee note is an output note. Totalling it into `outgoing` showed the user
  // an asset they never chose to send, and counting it in `outputNotesCreated` claimed a
  // note they did not create -- both invisible on a zero-fee chain, where no fee note exists.
  const { feeNote, userNotes } = splitExecutedOutputNotes(executed);
  return {
    account: getBech32AddressFromAccountId(executed.accountId()),
    outgoing: userNotes.flatMap(note => noteAssets(note)),
    incoming: inputNotes.notes().flatMap(note => noteAssets(note.note())),
    outgoingNfts: userNotes.flatMap(note => noteNfts(note)),
    incomingNfts: inputNotes.notes().flatMap(note => noteNfts(note.note())),
    unlistedAssets: 0,
    inputNotesConsumed: inputNotes.numNotes(),
    outputNotesCreated: userNotes.length,
    fee: (feeNote ? noteAssets(feeNote) : [])[0],
    storageChanged: !executed.accountPatch().storage().isEmpty(),
    viewConsumedNotes: inputNotes.notes().map(input => viewNoteOf(idOf(input), input.note())),
    createdNotes: userNotes.map(created => viewNoteOf(idOf(created), created))
  };
}
