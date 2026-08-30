import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { resolveAuthArg } from '@openzeppelin/miden-multisig-client';

import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';

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
 * ALSO APPLIED ON THE NON-GUARDIAN PIPELINE, where it is a backstop rather than a fix. For a
 * basic wallet miden-client injects `one_to_one` conversion info itself, but only when the
 * request's auth arg is unset; a non-empty one makes it return early instead. The commitment
 * this builds is the same shape the client would have built (`hash(CONVERSION_INFO || SALT)`
 * with the preimage in the advice map), so pre-empting it is safe, and keeping one code path
 * for both account kinds is worth more than the redundancy costs.
 *
 * Three properties this relies on:
 *
 *  - IDEMPOTENT. A request that already commits an auth arg is returned untouched, so paths that
 *    attach one at build time (the P2IDE send) are unaffected and this is safe as a backstop.
 *  - STABLE. The salt is fresh, so the result must be persisted and reused for BOTH
 *    `createCustomProposal` and its later execution — `prepareCustomExecution` re-derives the
 *    commitment from the bytes it is given and rejects a mismatch. Callers persist what this
 *    returns, never the input.
 *  - INERT WHERE IT IS NOT NEEDED. A chain that charges nothing is left byte-for-byte alone,
 *    so testnet keeps the client's own documented constant salt rather than a random one from
 *    here, and no transaction on it pays for a header read it has no use for.
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
    console.warn('[fee-auth] could not read request bytes to attach fee auth; passing through', error);
    return requestBytes;
  }
  // An EMPTY auth arg is not a commitment. miden-client says so explicitly where it decides
  // whether to inject conversion info -- "an empty one commits nothing, so it is treated as
  // unset" -- and a builder that was handed no auth arg can still serialize a zero word. Testing
  // only for `undefined` therefore skips exactly the requests that need annotating, which is why
  // the guardian swap kept aborting with ERR_FEE_CONVERSION_INFO_MISSING after this helper was
  // supposedly applied to it.
  const existing = request.authArg?.();
  if (existing !== undefined && !/^0x0*$/.test(existing.toHex())) {
    // Already committed by whoever built it; re-attaching would replace a live commitment
    // whose salt the caller may still need.
    return requestBytes;
  }

  // Read before touching the request: on a cache miss this drives its own RpcClient through the
  // WASM module, and re-entering that under the client lock traps.
  //
  // Both reads are network-dependent and BOTH are caught, for the same reason the
  // deserialization above is: this function must not be the thing that fails a transaction.
  // Without the catch a transient RPC blip took down a dApp `execute`, an AggLayer bridged-send
  // and an earn-deposit -- three flows that reached the chain with no header read at all before
  // this helper was inserted into their path.
  let feeFaucetId: string;
  try {
    // ONLY skip on a POSITIVE zero. `null` is "not discovered yet", and annotating then is the
    // fail-open choice: the commitment is inert on a chain that charges nothing (miden-client
    // returns early before it is consulted) but load-bearing on one that does.
    if ((await getVerificationBaseFee()) === 0) {
      return requestBytes;
    }
    feeFaucetId = await getNativeAssetId();
  } catch (error) {
    console.warn('[fee-auth] could not read the chain fee parameters; passing through', error);
    return requestBytes;
  }
  const feeAuth = resolveAuthArg(randomFeeSalt(), accountRefToSdk(feeFaucetId));

  let annotated = request.withAuthArg(feeAuth.authArg);
  if (feeAuth.adviceMap !== undefined) {
    annotated = annotated.extendAdviceMap(feeAuth.adviceMap);
  }
  return annotated.serialize();
}
