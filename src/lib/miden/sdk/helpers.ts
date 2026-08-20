import {
  Account,
  AccountId,
  Address,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteType,
  TransactionRequest,
  TransactionRequestBuilder
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
 * Parse a wallet-account identifier into an SDK `AccountId`, accepting both
 * the bare bech32 address and the composite `WalletAccount.publicKey`
 * (`<address>_<suffix>`) — `Address.fromBech32` rejects the composite form.
 */
export function walletAccountIdToSdk(id: string): AccountId {
  return accountIdStringToSdk(id.split('_')[0] ?? id);
}

/**
 * Canonicalize a wallet-account identifier so the two id forms that meet inside
 * the wallet compare equal. dApp/adapter-initiated transactions arrive with the
 * bare bech32 address (e.g. `mtst1…5068r3`), whereas `WalletAccount.publicKey` is
 * a composite `<address>_<suffix>` (e.g. `mtst1…5068r3_qr7qqq9wr6w`). Reduce both
 * to the SDK account id derived from the address portion; fall back to the raw
 * address portion if it can't be parsed.
 */
export function canonicalWalletAccountId(id: string): string {
  const address = id.split('_')[0] ?? id;
  try {
    return accountIdStringToSdk(address).toString();
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
 */
export function accountRefToSdk(ref: string): AccountId {
  if (ref.startsWith('0x') || ref.startsWith('0X')) {
    return AccountId.fromHex(ref);
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
 */
function resolveHeldFungibleAsset(account: Account | undefined, faucetRef: string, amount: bigint): FungibleAsset {
  const faucetId = accountRefToSdk(faucetRef);
  const faucetHex = faucetId.toString();
  const held = account
    ?.vault()
    .fungibleAssets()
    .find(asset => asset.faucetId().toString() === faucetHex);
  if (!held) {
    return new FungibleAsset(faucetId, amount);
  }
  return FungibleAsset.fromVaultKey(held.vaultKey(), amount);
}

/**
 * The single request builder for every wallet send: resolves the outgoing
 * asset from the sender's vault (callback flag included, see
 * `resolveHeldFungibleAsset`) and wraps it in a P2ID note — P2IDE when a
 * reclaim height is given — as the request's own output note. Guardian
 * recallable sends, the offscreen-prover path, and the high-level send all
 * route through this so they can't drift on asset construction again.
 */
export function buildSendTransactionRequest(
  senderAccount: Account | undefined,
  sender: AccountId,
  recipient: AccountId,
  faucetRef: string,
  amount: bigint,
  noteType: NoteType,
  reclaimAfter?: number
): TransactionRequest {
  const asset = resolveHeldFungibleAsset(senderAccount, faucetRef, amount);
  const assets = new NoteAssets([asset]);
  const note =
    reclaimAfter != null
      ? Note.createP2IDENote(sender, recipient, assets, reclaimAfter, null, noteType, new NoteAttachment())
      : Note.createP2IDNote(sender, recipient, assets, noteType, new NoteAttachment());
  return new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note])).build();
}
