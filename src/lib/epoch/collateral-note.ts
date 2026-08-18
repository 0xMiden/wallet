import {
  AccountId,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteType,
  TransactionRequestBuilder
} from '@miden-sdk/miden-sdk/lazy';

import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';

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
  return withWasmClientLock(async () => {
    const asset = new FungibleAsset(toAccountId(args.faucetId), args.amount);
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
    return new TransactionRequestBuilder()
      .withOwnOutputNotes(new NoteArray([note]))
      .build()
      .serialize();
  });
}
