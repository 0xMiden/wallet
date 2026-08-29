import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { resolveAuthArg } from '@openzeppelin/miden-multisig-client';

import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { accountRefToSdk, randomFeeSalt } from '../sdk/helpers';

/**
 * Returns `requestBytes` carrying fee conversion info in its auth args.
 *
 * Since protocol 0.16 the fee is paid inside the auth procedure, which reads the fee faucet and
 * conversion rate from the AUTH ARGS. The client injects that for accounts whose auth args it
 * owns — but a multisig account's auth arg belongs to the multisig, so a Guardian CUSTOM proposal
 * has to carry it or `fee::pay_fee` aborts with `ERR_FEE_CONVERSION_INFO_MISSING`.
 *
 * Custom proposals take bytes that were already serialized, often built somewhere the wallet does
 * not control — a bridged send, an earn deposit, a swap, a dApp's own `execute` request. Those
 * cannot be rebuilt, so the auth arg has to be attached to the finished request. That is what
 * `TransactionRequest.withAuthArg` exists for; without it this is impossible rather than merely
 * awkward, because the type is only constructible through its builder.
 *
 * Two properties this relies on:
 *
 *  - IDEMPOTENT. A request that already commits an auth arg is returned untouched, so paths that
 *    attach one at build time (the P2IDE send) are unaffected and this is safe as a backstop.
 *  - STABLE. The salt is fresh, so the result must be persisted and reused for BOTH
 *    `createCustomProposal` and its later execution — `prepareCustomExecution` re-derives the
 *    commitment from the bytes it is given and rejects a mismatch. Callers persist what this
 *    returns, never the input.
 *
 * Deliberately NOT the SDK's `withFeeConversionInfo`: that additionally flags the request as
 * declaring conversion info, which makes the client classify the account's auth component first —
 * and a guarded multisig built by the JS package pins its own MASM's procedure roots, which the
 * client cannot match, so it counts zero auth components and refuses the request.
 */
export async function ensureFeeAuthOnRequestBytes(requestBytes: Uint8Array): Promise<Uint8Array> {
  let request: TransactionRequest;
  try {
    request = TransactionRequest.deserialize(requestBytes);
  } catch (error) {
    // Cannot annotate what cannot be read. Pass the bytes through unchanged rather than failing
    // the transaction here: on a fee-charging chain the kernel then reports the real reason
    // (`ERR_FEE_CONVERSION_INFO_MISSING`), which is more useful than a deserialization error
    // standing in for it, and on a zero-fee chain the request was fine as-is.
    console.warn('[Guardian] could not read request bytes to attach fee auth; passing through', error);
    return requestBytes;
  }
  const existing = request?.authArg?.();
  if (request === undefined || existing !== undefined) {
    // Already committed by whoever built it; re-attaching would replace a live commitment
    // whose salt the caller may still need.
    return requestBytes;
  }

  // Read before touching the request: on a cache miss this drives its own RpcClient through the
  // WASM module, and re-entering that under the client lock traps.
  const feeFaucetId = await getNativeAssetId();
  const feeAuth = resolveAuthArg(randomFeeSalt(), accountRefToSdk(feeFaucetId));

  let annotated = request.withAuthArg(feeAuth.authArg);
  if (feeAuth.adviceMap !== undefined) {
    annotated = annotated.extendAdviceMap(feeAuth.adviceMap);
  }
  return annotated.serialize();
}
