import {
  Account,
  AccountId,
  Address,
  FeeConversionInfo,
  Felt,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteType,
  TransactionRequest,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import { getNetworkId } from 'lib/miden-chain/constants';

export function getBech32AddressFromAccountId(accountId: AccountId): string {
  const accountAddress = Address.fromAccountId(accountId, 'BasicWallet');
  return accountAddress.toBech32(getNetworkId());
}

export function accountIdStringToSdk(accountIdStr: string): AccountId {
  return Address.fromBech32(accountIdStr).accountId();
}

/**
 * Parse a wallet-account identifier into an SDK `AccountId`, accepting both the
 * bare bech32 address and the composite `WalletAccount.publicKey`
 * (`<address>_<suffix>`).
 *
 * Splitting the suffix off — which `accountRefToSdk` now does for every caller —
 * is what makes the composite form safe to pass here. `Address.fromBech32` does
 * parse it directly for SOME suffixes — the trailing segment is its own bech32
 * routing-parameter encoding, and a `_qr7qqq9wr6w` address round-trips to the
 * same account id — but it throws for others (`_qruqqypuyph` fails as an
 * "invalid note tag length"). Splitting first makes the parse independent of
 * whichever routing parameters the wallet appended.
 *
 * Hex is accepted too, via `accountRefToSdk`: this has to stay at least as
 * permissive as the SDK's own `resolveAccountRef`, which every id handed to
 * `transactions.*` goes through. A sender id that the SDK resolves but this
 * rejects fails the send before it is built.
 *
 * Kept as a distinct name from `accountRefToSdk` for intent — callers here are
 * passing something they believe is one of the user's own accounts — even though
 * the two now parse identically.
 */
export function walletAccountIdToSdk(id: string): AccountId {
  return accountRefToSdk(id);
}

/**
 * Canonicalize a wallet-account identifier so the two id forms that meet inside
 * the wallet compare equal. dApp/adapter-initiated transactions arrive with the
 * bare bech32 address (e.g. `mtst1…5068r3`), whereas `WalletAccount.publicKey` is
 * a composite `<address>_<suffix>` (e.g. `mtst1…5068r3_qr7qqq9wr6w`). Reduce both
 * to the SDK account id derived from the address portion; fall back to the raw
 * address portion if it can't be parsed.
 *
 * Hex goes through `accountRefToSdk` for the same reason `walletAccountIdToSdk`
 * does, and it matters more here: an unparseable id falls back to its own raw
 * text, so a hex-form id would canonicalize to the hex string and never compare
 * equal to the same account in bech32 form. `sameWalletAccountId` would then
 * answer "different account" for one that is in fact the same — the exact
 * guardian misroute (AUTH_UNAUTHORIZED) it exists to prevent.
 */
export function canonicalWalletAccountId(id: string): string {
  const address = id.split('_')[0] ?? id;
  try {
    return accountRefToSdk(address).toString();
  } catch {
    return address;
  }
}

/**
 * True when two ids refer to the same wallet account despite differing forms
 * (bare bech32 address vs composite `WalletAccount.publicKey`). Use this instead
 * of a raw `===` anywhere a dApp-supplied account id is matched against a stored
 * `WalletAccount.publicKey` — a raw compare misses on dApp txs and misroutes a
 * Guardian account through the non-guardian path (no co-signature → the on-chain
 * guardian auth fails as AUTH_UNAUTHORIZED).
 */
export function sameWalletAccountId(a: string, b: string): boolean {
  return canonicalWalletAccountId(a) === canonicalWalletAccountId(b);
}

/**
 * Parse an account reference in either of the two forms the wallet stores —
 * `0x…` hex or bech32 — into an SDK `AccountId`. Faucet ids in particular
 * appear in both forms depending on the producer.
 *
 * A composite `<address>_<suffix>` is reduced to its address first, so this
 * accepts everything `resolveAccountId` (the offscreen realm's mirror of this
 * function) accepts. They must agree: the same send resolves its recipient
 * through this on the direct path and through `resolveAccountId` when routed
 * offscreen, so a form that only one of them parses makes the send succeed or
 * throw depending on which realm happened to run it. Splitting is safe for the
 * non-composite forms because neither bech32 nor hex can contain an underscore.
 */
export function accountRefToSdk(accountRef: string): AccountId {
  const ref = accountRef.split('_')[0] ?? accountRef;
  if (ref.startsWith('0x') || ref.startsWith('0X')) {
    // Lowercased prefix: `AccountId.fromHex` requires a literal '0x' and rejects
    // '0X…' outright ("hex encoded data must start with 0x"), even though the
    // hex DIGITS are case-insensitive. Without this the '0X' arm routes straight
    // to a guaranteed throw — and in `canonicalWalletAccountId`, which swallows
    // that throw and falls back to the raw text, it would make the same account
    // in '0X' and bech32 form compare as two different accounts.
    return AccountId.fromHex(`0x${ref.slice(2)}`);
  }
  return accountIdStringToSdk(ref);
}

/**
 * Builds the fungible asset for an outgoing note from the sender's held vault
 * key, falling back to a freshly constructed asset when the faucet isn't in
 * the vault (surfacing the missing-asset error during execution).
 *
 * The callback flag is part of an asset's vault key, so rebuilding the asset
 * from faucet/amount with the constructor's default `Disabled` flag addresses
 * a different vault slot than the one holding a callback-enabled balance
 * (assets minted by a transfer-policy faucet, e.g. AggLayer-bridged tokens)
 * and the kernel aborts the send with "the amount of the asset in the vault
 * is less than the amount to remove". Deriving from the vault key is exact
 * for Disabled assets too, so every send uses this path. Mirrors
 * `resolveFungibleAssetFromVault` in @openzeppelin/miden-multisig-client's
 * p2id.ts.
 *
 * One faucet can occupy TWO vault slots — the flag is part of the key, so an
 * Enabled and a Disabled balance from the same faucet do not merge. Matching
 * on faucet id alone would then pick whichever slot the vault happens to
 * enumerate first, which can be the one that cannot fund the note: the same
 * kernel abort this function exists to prevent, just reached by a different
 * route. So prefer a slot that covers `amount`, and only fall back to the
 * largest slot (for a truthful "less than the amount to remove" error) when
 * no single slot does.
 */
// The SDK's own documented ceiling for a fungible asset amount ("an amount above
// the maximum fungible asset amount, `2^63 - 2^31`" — FungibleAsset.fromVaultKey
// in miden_client_web.d.ts). The SDK enforces it, so this bound exists for what
// the SDK CANNOT catch: wasm-bindgen narrows a JS BigInt at the boundary, so a
// value at or above 2^64 is truncated BEFORE any validation runs — 2^64 arrives
// as 0 and 2^64 + 50 as 50, quietly building a note for a fraction of what the
// user approved. Checking the real maximum here (rather than merely the wrap
// point) also means the wallet owns the error message. The amount reaches this
// function straight from `BigInt(amount)` on a dApp-supplied string, and every
// send funnels through here, so this is the one place worth checking.
const MAX_FUNGIBLE_ASSET_AMOUNT = (1n << 63n) - (1n << 31n);

export function resolveHeldFungibleAsset(
  account: Account | undefined,
  faucetRef: string,
  amount: bigint
): FungibleAsset {
  if (amount < 0n || amount > MAX_FUNGIBLE_ASSET_AMOUNT) {
    throw new Error(`Asset amount ${amount} is outside the representable range (0..${MAX_FUNGIBLE_ASSET_AMOUNT})`);
  }
  const faucetId = accountRefToSdk(faucetRef);
  const faucetHex = faucetId.toString();
  if (!account) {
    // Not expected on any send path — the sender's account is what the send is
    // executed against. Log it, because the fallback below rebuilds the asset
    // with the constructor's default Disabled flag and so silently reinstates
    // the callback-asset bug rather than failing loudly.
    console.warn('[send] sender account unavailable; building outgoing asset without its vault key');
  }
  const heldForFaucet = (account?.vault().fungibleAssets() ?? []).filter(
    asset => asset.faucetId().toString() === faucetHex
  );
  // Prefer a slot that can fund the whole amount. When two slots of the same
  // faucet both could, this decides which CALLBACK FLAG the outgoing asset
  // carries — the largest-slot fallback below would otherwise pick by size and
  // could hand back the wrong variant.
  const held =
    heldForFaucet.find(asset => asset.amount() >= amount) ??
    heldForFaucet.reduce<FungibleAsset | undefined>(
      (largest, asset) => (largest && largest.amount() >= asset.amount() ? largest : asset),
      undefined
    );
  if (!held) {
    // The local vault shows nothing from this faucet. Usually stale local state
    // rather than a real shortfall, so this still builds the request and lets
    // the kernel decide — but the asset it builds carries the constructor's
    // default Disabled flag, which is precisely the bug this function exists to
    // fix. Log it: otherwise a "failed to remove the fungible asset from the
    // vault" lands with nothing to distinguish it from the original defect.
    console.warn('[send] no vault slot for this faucet; building outgoing asset without a vault key');
    return new FungibleAsset(faucetId, amount);
  }
  if (held.amount() < amount) {
    // No SINGLE slot covers the amount. The sum across slots may well, because
    // one faucet occupies a separate slot per callback flag and this builder
    // emits a single-slot asset — so the kernel's remove-asset assertion will
    // reject a request that the user's total balance looks able to fund. Left
    // as a warning rather than a hard failure: local vault state can lag the
    // chain, and refusing here would block a send that a fresher view allows.
    console.warn('[send] no single vault slot can fund this amount; the balance may be split across callback flags');
  }
  return FungibleAsset.fromVaultKey(held.vaultKey(), amount);
}

/**
 * The single request builder for every P2ID/P2IDE wallet send: resolves the
 * outgoing asset from the sender's vault (callback flag included, see
 * `resolveHeldFungibleAsset`) and wraps it in a P2ID note — P2IDE when a
 * reclaim height is given — as the request's own output note. Guardian
 * recallable sends, the offscreen-prover path, and the high-level send all
 * route through this so they can't drift on asset construction again.
 *
 * Not every note-emitting path routes through this builder: the Epoch collateral
 * note (`buildEpochCollateralRequestBytes`) and the AggLayer B2AGG note build
 * their own requests, because each carries an attachment this builder cannot
 * express. They do still resolve their outgoing asset the same way — Epoch calls
 * `resolveHeldFungibleAsset` directly, and B2AGG picks its flag explicitly — so
 * the callback-flag bug is closed on every path that removes an asset from a
 * vault, not just the ones shaped like a send.
 *
 * Building the note here rather than in `newSendTransactionRequest` reproduces
 * the Rust builder exactly — same script root, tag, storage and note type —
 * with ONE difference: `createP2ID[E]Note` requires a `NoteAttachment`, and the
 * 0.15 surface has no empty one (content is 1..=256 words), so `new
 * NoteAttachment()` encodes the empty case as a single zero `Word` with the
 * `none` scheme. The Rust path emitted zero attachments instead. Nothing on
 * chain reads a P2ID attachment, but a reader that treats any attachment word
 * as a payload must skip this one — see `attachmentOrderAndDepth`.
 */
/**
 * A fresh salt for a fee-conversion commitment.
 *
 * Four field elements from the CSPRNG, each masked to 63 bits so it is always
 * below the field modulus (2^64 - 2^32 + 1) without rejection sampling — the
 * commitment only needs the salt to be unpredictable and non-repeating.
 */
function randomFeeSalt(): Word {
  const raw = new BigUint64Array(4);
  crypto.getRandomValues(raw);
  return Word.newFromFelts(Array.from(raw, v => new Felt(v & 0x7fff_ffff_ffff_ffffn)));
}

export function buildSendTransactionRequest(
  senderAccount: Account | undefined,
  sender: AccountId,
  recipient: AccountId,
  faucetRef: string,
  amount: bigint,
  noteType: NoteType,
  reclaimAfter?: number,
  feeFaucetId?: string
): TransactionRequest {
  const asset = resolveHeldFungibleAsset(senderAccount, faucetRef, amount);
  const assets = new NoteAssets([asset]);
  const note =
    reclaimAfter != null
      ? Note.createP2IDENote(sender, recipient, assets, reclaimAfter, null, noteType, new NoteAttachment())
      : Note.createP2IDNote(sender, recipient, assets, noteType, new NoteAttachment());
  const builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note]));
  // Since protocol 0.16 `fee::pay_fee` reads the fee faucet and conversion rate
  // from the AUTH ARGS, and aborts with "paying a non-zero fee requires conversion
  // info committed via the auth args" when they are absent. The client injects that
  // for accounts whose auth args it owns — but a multisig account's auth arg is the
  // multisig's own, so a request built here for a Guardian proposal has to commit it
  // explicitly or the transaction cannot execute on a fee-charging chain.
  //
  // Only the Guardian CUSTOM-proposal path needs this: the typed proposal APIs
  // commit their own conversion info. Generating the salt here (rather than taking
  // it) is safe precisely because this request's bytes are built once, persisted on
  // the row, and reused verbatim for both the proposal and its execution — so the
  // commitment stays stable across the retry that reuses them.
  if (feeFaucetId !== undefined) {
    // `accountRefToSdk`, not `AccountId.fromHex`: the wallet's native-asset id is a
    // bech32 address, and fromHex rejects it with "expected hex data to have length
    // 32 ... found 49". The shared resolver accepts both forms.
    builder.withFeeConversionInfo(FeeConversionInfo.oneToOne(accountRefToSdk(feeFaucetId)), randomFeeSalt());
  }
  return builder.build();
}

/**
 * Re-emits a PSWAP-create request with its offered asset taken from the
 * creator's vault key, callback flag included.
 *
 * The PSWAP API takes a faucet id and an amount — not an asset — and builds the
 * offered asset with `FungibleAsset::new` on the Rust side, which always yields
 * the `Disabled` flag. That flag is part of the vault key, so offering a
 * callback-ENABLED asset addressed an empty vault slot and the kernel rejected
 * the create with the same "failed to remove the fungible asset from the vault"
 * every send used to produce. There is no flag parameter anywhere in the chain,
 * so unlike the send paths this cannot be fixed by passing a better argument.
 *
 * What it CAN do is rebuild the note. Everything the PSWAP note carries beyond
 * its assets — script root, storage, serial number, tag, metadata, attachments —
 * is already computed correctly by the SDK and is readable off the request it
 * returns, so this lifts all of it verbatim and substitutes only the assets.
 * Rebuilt with the SAME asset the result is byte-identical (same note id), which
 * is what makes this a substitution rather than a reconstruction; the swap's
 * order id is the note's serial number, and PSWAP lineage registration keys off
 * the script root, so `pswap.lineage()`, `cancelByOrder` and the wallet's own
 * settlement matching are unaffected.
 *
 * `reference` MUST be the request from a single `newPswapCreateTransactionRequest`
 * call that is then discarded: each call draws a fresh serial number, so
 * building one to inspect and another to submit yields two different orders.
 *
 * NOT fixed here, because it is out of reach: the REQUESTED asset's flag is
 * carried in the note's storage and the SDK writes `Disabled` there too, and the
 * fill path (`build_pswap_consume`, in the Rust client) reads only the faucet id
 * back out and rebuilds the fill asset with the same defaulting constructor. A
 * callback-enabled REQUESTED token is therefore unfillable, and no wallet-side
 * substitution reaches it — the fill API takes an input note and two amounts,
 * with no asset to replace and no output note to rewrite. The wallet is
 * maker-only today (`pswapConsume` appears only in E2E-gated test hooks), so
 * this is latent rather than live.
 */
export function buildPswapCreateRequest(
  creatorAccount: Account | undefined,
  reference: TransactionRequest,
  offeredFaucetRef: string,
  offeredAmount: bigint
): TransactionRequest {
  const referenceNote = reference.expectedOutputOwnNotes()[0];
  if (!referenceNote) {
    // The SDK builder always emits exactly one own output note. Rather than
    // index into nothing, fail with something that names the cause.
    throw new Error('PSWAP create request carried no own output note to rebuild');
  }
  const asset = resolveHeldFungibleAsset(creatorAccount, offeredFaucetRef, offeredAmount);
  const note = Note.withAttachments(
    new NoteAssets([asset]),
    referenceNote.metadata(),
    referenceNote.recipient(),
    referenceNote.attachments()
  );
  return new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note])).build();
}
