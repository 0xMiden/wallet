import {
  AccountId,
  Note,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteType,
  TransactionRequestBuilder
} from '@miden-sdk/miden-sdk/lazy';

import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { accountIdStringToSdk, resolveHeldFungibleAsset } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { resolveBuildTimeFeeAuth } from 'lib/miden/transaction/guardian-fee-auth';

import { getCurrentMidenBlock } from './chain';

/**
 * Parse a wallet account identifier into an SDK `AccountId`. Accepts the three
 * forms that reach the Epoch flows: bare bech32, composite guardian
 * `<address>_<suffix>` (only the address part is an account id), and 0x hex
 * (the form the Epoch SDK hands to the mint callback).
 */
function toAccountId(id: string): AccountId {
  const address = id.split('_')[0] ?? id;
  if (address.startsWith('0x')) {
    return AccountId.fromHex(address);
  }
  return accountIdStringToSdk(address);
}

export interface EpochCollateralNoteArgs {
  /** Sender's Miden account (bech32, composite, or hex). */
  senderAccountId: string;
  /** Epoch allocator account the collateral note is addressed to. */
  allocatorId: string;
  /** Faucet of the collateral asset. */
  faucetId: string;
  /** Collateral amount in faucet base units. */
  amount: bigint;
  /**
   * RELATIVE blocks-until-reclaim window, exactly as supplied by the Epoch SDK's
   * mint callback (allocator minimum + SDK drift buffer). Never recompute or
   * hardcode it — the SDK derives it from the allocator's live config.
   */
  recallBlocks: number;
  /**
   * Mandate-binding attachment felts, exactly as supplied by the Epoch SDK's
   * mint callback. The allocator recomputes the same EIP-712 witness hash from
   * the submitted mandate and rejects the note unless its attachment matches
   * ("Miden note is not bound to the intent mandate") — so the felts must be
   * written VERBATIM: no reordering, truncation, hashing, or `number` round-trips.
   */
  bindingAttachmentFelts: bigint[];
}

/**
 * Build (and serialize) the transaction request that mints an Epoch collateral
 * note — the smallocator PR #38 contract: a PUBLIC, reclaimable P2IDE note
 * addressed to the allocator, honoring the SDK-supplied `recallBlocks`, with the
 * SDK-supplied mandate-binding felts as its single attachment.
 *
 * `newSendTransactionRequest` cannot express the attachment, so the note is
 * built explicitly via `Note.createP2IDENote` and submitted as an own output
 * note — the same mechanism as the Agglayer B2AGG bridge note. The P2IDE serial
 * number is random, so the returned bytes must be built ONCE and persisted on
 * the row (`requestBytes`); retries and the guardian propose/sign path reuse
 * the exact same bytes.
 *
 * The reclaim height is `current chain head + recallBlocks`. The allocator
 * validates the REMAINING window against its own (later) head; the blocks that
 * elapse during proving/submission (and guardian co-signing) are covered by the
 * ~1000-block buffer the SDK bakes into `recallBlocks`.
 */
export async function buildEpochCollateralRequestBytes(args: EpochCollateralNoteArgs): Promise<Uint8Array> {
  // Fresh RPC head (not the local sync height) so a cold-started wallet can't
  // understate the reclaim height. Also ensures the SDK WASM is initialized
  // before the note classes below are constructed.
  const currentBlock = await getCurrentMidenBlock();
  // Resolved BEFORE the client lock: on a cache miss this drives its own RpcClient
  // through the WASM module, and re-entering it under the lock traps.
  const feeAuth = await resolveBuildTimeFeeAuth();
  return withWasmClientLock(async hold => {
    // The collateral asset is REMOVED from the sender's vault, so it has to carry
    // the vault key of the slot it is actually held in — the callback flag is part
    // of that key. Building it from faucet id + amount always yields the default
    // Disabled flag, so a collateral faucet issuing callback-ENABLED assets
    // addressed an empty slot and the kernel rejected the note ("failed to remove
    // the fungible asset from the vault"), taking the whole bridge or deposit with
    // it. Same resolution as every send path; see `resolveHeldFungibleAsset`.
    //
    // Read through the proxy, like the chain head above, so that under the
    // offscreen client the vault key comes from the realm that will EXECUTE this
    // request rather than from a second client that could disagree. The proxy read
    // is unlocked by design and this scope already holds the client lock, which is
    // what that contract requires.
    const senderAccount = await midenClientProxy.getAccount(toAccountId(args.senderAccountId).toString());
    // Before touching the returned account: an eviction during the read above
    // hands the mutex to a successor without stopping this callback, and
    // `resolveHeldFungibleAsset` reads `vault().fungibleAssets()` — a WASM call
    // on an object borrowed from the client's RefCell, so continuing would be
    // the double borrow, not a stale read. Everything in this hold is write
    // PREP (the request is only built and serialized here, nothing is
    // submitted), so aborting is always safe.
    assertWasmHoldCurrent(hold, 'before the collateral vault read');
    const asset = resolveHeldFungibleAsset(senderAccount ?? undefined, args.faucetId, args.amount);
    const attachment = new NoteAttachment(BigUint64Array.from(args.bindingAttachmentFelts));
    const note = Note.createP2IDENote(
      toAccountId(args.senderAccountId),
      toAccountId(args.allocatorId),
      new NoteAssets([asset]),
      currentBlock + args.recallBlocks,
      null,
      NoteType.Public,
      attachment
    );
    // Attached at BUILD time: the SDK exposes no auth-arg setter on a finished
    // `TransactionRequest`, only on the builder. See `resolveBuildTimeFeeAuth`.
    let builder = new TransactionRequestBuilder().withOwnOutputNotes(new NoteArray([note]));
    if (feeAuth !== undefined) {
      builder = builder.withAuthArg(feeAuth.authArg);
      if (feeAuth.adviceMap !== undefined) {
        builder = builder.extendAdviceMap(feeAuth.adviceMap);
      }
    }
    return builder.build().serialize();
  });
}
