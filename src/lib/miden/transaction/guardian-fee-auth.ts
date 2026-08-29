import { NoteArray, TransactionRequest, TransactionRequestBuilder } from '@miden-sdk/miden-sdk/lazy';
import { resolveAuthArg } from '@openzeppelin/miden-multisig-client';

import { accountRefToSdk, randomFeeSalt } from 'lib/miden/sdk/helpers';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';

/**
 * Thrown when a request bound for a Guardian CUSTOM proposal cannot be given the
 * fee-conversion auth arg it needs. Distinct from a vault shortfall: the account
 * may be fully funded — topping it up changes nothing.
 */
export class CustomProposalFeeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomProposalFeeAuthError';
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Give a Guardian CUSTOM proposal's request bytes the fee-conversion auth arg
 * `fee::pay_fee` needs, or explain why they cannot have it.
 *
 * ## Why the pre-built paths need this at all
 *
 * On a multisig account the auth-arg slot belongs to the multisig, so the client
 * cannot inject conversion info the way it does for a basic wallet — the request
 * has to carry it. `buildSendTransactionRequest` does that for every request the
 * guardian pipeline builds ITSELF (see its `feeAuth` parameter), but four
 * guardian flows hand `createCustomProposal` bytes that were serialized
 * elsewhere, before any of that ran:
 *
 * - Epoch bridged-send and earn-deposit — `buildEpochCollateralRequestBytes`
 *   persists the P2IDE collateral request on the row at QUEUE time, and
 *   `ensureGuardianRecallableSendRequestBytes` returns those bytes verbatim (its
 *   own build path, the one that adds the auth arg, is only a fallback for
 *   legacy attachment-less rows).
 * - AggLayer bridged-send — the B2AGG request is likewise built and persisted by
 *   `initiateB2AggBridge`.
 * - dApp `execute` — the bytes come from the page.
 *
 * `createCustomProposal` deserializes what it is given and injects nothing, and
 * `signAndCreateTransactionRequest` re-deserializes the SAME bytes at execution
 * time, so an unannotated request stays unannotated all the way into the kernel
 * and aborts at `creating-proposal` with "paying a non-zero fee requires
 * conversion info committed via the auth args".
 *
 * ## Why this rebuilds rather than mutates
 *
 * `TransactionRequest` exposes `extendAdviceMap` but no `withAuthArg` — only the
 * BUILDER can set an auth arg — so the request has to be re-emitted through a
 * builder. A builder cannot be seeded from an existing request either, and the
 * request's readers do not cover every field it may carry (input notes and a
 * custom script are both invisible from here), so a blind rebuild could silently
 * drop content and change what the user signs.
 *
 * Hence the round-trip proof: re-emit WITHOUT the auth arg first and require the
 * result to be byte-identical to the input. All three wallet-side producers
 * above build exactly `new TransactionRequestBuilder().withOwnOutputNotes(...)`,
 * so for them it is, and the rebuild is then known to be lossless rather than
 * assumed to be. Anything richer — a dApp request with input notes or a script,
 * or a producer that grows a field — fails the comparison and raises
 * `CustomProposalFeeAuthError` instead of quietly re-emitting something else.
 *
 * ## Why it is gated on a non-zero fee
 *
 * A MISSING commitment only aborts when there is a fee to pay, which is why this
 * whole class of failure is invisible to CI (every guardian workflow pins
 * `verification-base-fee: '0'`). Gating on the discovered fee keeps a zero-fee
 * chain byte-for-byte unchanged, so the rebuild — and the throw — can only be
 * reached where the alternative was a failed transaction anyway. An undiscovered
 * fee (`null`) fails open for the same reason `isWorthClaiming` does: refusing a
 * transaction over a failed RPC read is worse than letting the kernel answer.
 *
 * Returns the bytes to use — the caller MUST persist them on the row, because
 * the proposal's signed summary is built from these bytes and execution
 * re-deserializes them.
 */
export async function ensureCustomProposalFeeAuth(requestBytes: Uint8Array): Promise<Uint8Array> {
  // Both reads happen outside the lock, deliberately: on a cache miss they drive
  // their own `RpcClient` through `ensureSdkWasmReady`, and re-entering the
  // single-threaded WASM module while holding the client lock traps as a bare
  // `RuntimeError` and poisons the client. Same rule, and the same reason, as the
  // fee read in `ensureGuardianRecallableSendRequestBytes`.
  //
  // A THROWN read fails open like an undiscovered one. These are network reads on
  // the critical path of a transaction the user already confirmed, and the
  // annotation is only ever an improvement on bytes that would otherwise be
  // rejected — so a failed read must not be the thing that stops the send.
  let feeFaucetId: string;
  try {
    const baseFee = await getVerificationBaseFee();
    if (baseFee === null || baseFee <= 0) return requestBytes;
    feeFaucetId = await getNativeAssetId();
  } catch (error) {
    console.warn('[Guardian] could not read the chain fee; leaving the custom proposal request as built', error);
    return requestBytes;
  }
  return withWasmClientLock(
    async () => {
      const request = TransactionRequest.deserialize(requestBytes);
      // Already carries one — the recallable-send build path sets it, and a
      // retry re-reads its own persisted bytes. Re-emitting would draw a fresh
      // salt and invalidate the signatures already gathered for this proposal.
      if (request.authArg() !== undefined) return requestBytes;
      const ownNotes = request.expectedOutputOwnNotes();
      const rebuiltPlain = new TransactionRequestBuilder()
        .withOwnOutputNotes(new NoteArray(ownNotes))
        .build()
        .serialize();
      if (!sameBytes(rebuiltPlain, requestBytes)) {
        throw new CustomProposalFeeAuthError(
          'This transaction cannot be paid for on a Guardian account: its request carries content ' +
            'beyond its own output notes, so the wallet cannot re-emit it with the fee conversion ' +
            'info the network requires.'
        );
      }
      // Plain auth arg + advice map, NOT the SDK's `withFeeConversionInfo`: the
      // flagged form makes the client classify the account's auth component
      // first, and a guarded multisig built by the JS package pins its own MASM's
      // procedure roots while the client knows miden_standards' — so it counts
      // zero auth components and refuses the request. Same route as
      // `buildSendTransactionRequest` and the package's typed proposals; the
      // kernel gets identical conversion info either way.
      const feeAuth = resolveAuthArg(randomFeeSalt(), accountRefToSdk(feeFaucetId));
      let builder = new TransactionRequestBuilder()
        .withOwnOutputNotes(new NoteArray(ownNotes))
        .withAuthArg(feeAuth.authArg);
      if (feeAuth.adviceMap !== undefined) {
        builder = builder.extendAdviceMap(feeAuth.adviceMap);
      }
      return builder.build().serialize();
    },
    { label: 'guardian-custom-proposal-fee-auth' }
  );
}
