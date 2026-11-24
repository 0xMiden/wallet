import { Felt, InputNote, type MidenClient, Word } from '@miden-sdk/miden-sdk/lazy';

import { feeAwareRequestBuilder, randomFeeSalt, sameWalletAccountId, walletAccountIdToSdk } from './helpers';
import type { AssertLive, PswapConsumeRequestInputs } from './miden-client-interface';
import { GC_SALE_SCRIPT_ROOT, readPublicPswapNote } from './pswap-order-note';

/** Build a purchase with an explicit payment. Call under the WASM client lock. */
export async function buildGcSaleRequest(
  client: MidenClient,
  accountId: string,
  { noteId, fillAmount, creatorAccountId }: PswapConsumeRequestInputs,
  assertLive: AssertLive
): Promise<Uint8Array> {
  if (sameWalletAccountId(accountId, creatorAccountId)) {
    throw new Error("A GameCoin purchase cannot consume the buyer's own sale");
  }
  const read = await readPublicPswapNote(noteId, GC_SALE_SCRIPT_ROOT);
  assertLive('after the node note read');
  if (read.kind !== 'open') throw new Error(`GameCoin sale note ${noteId} is unavailable`);
  if (!sameWalletAccountId(read.fields.creator, creatorAccountId)) {
    throw new Error(`GameCoin sale note ${noteId} has a different seller`);
  }
  const requested = read.fields.storage[2] ?? 0n;
  const floor = read.fields.storage[3] ?? 0n;
  if (fillAmount < 1n || fillAmount > requested || fillAmount < (floor < requested ? floor : requested)) {
    throw new Error(`GameCoin sale note ${noteId} refuses the payment amount`);
  }
  const buyer = walletAccountIdToSdk(accountId).toString();
  const builder = await feeAwareRequestBuilder(client, buyer, randomFeeSalt());
  assertLive('after the fee-aware request builder');
  const input = InputNote.authenticated(read.note, read.inclusionProof);
  const args = Word.newFromFelts([new Felt(fillAmount), new Felt(0n), new Felt(0n), new Felt(0n)]);
  return builder.withExplicitInputNote(input, args).build().serialize();
}
