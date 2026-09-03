import type { AdviceMap, Word } from '@miden-sdk/miden-sdk/lazy';
import { resolveAuthArg } from '@openzeppelin/miden-multisig-client';

import { getNativeAssetId, getVerificationBaseFee } from 'lib/miden-chain/native-asset';

import { accountRefToSdk, randomFeeSalt } from '../sdk/helpers';

/** The auth argument a request must carry to pay its fee, plus the preimage it is read back from. */
export type FeeAuth = { authArg: Word; adviceMap?: AdviceMap };

/**
 * Resolves the fee conversion info a request must be BUILT with, or `undefined` when it needs none.
 *
 * Since protocol 0.16 the fee is paid inside the auth procedure, which reads the fee faucet and
 * conversion rate from the AUTH ARGS. miden-client injects that for accounts whose auth args it
 * owns — but a multisig account's auth arg belongs to the multisig, so a Guardian CUSTOM proposal
 * has to carry it or `fee::pay_fee` aborts with `ERR_FEE_CONVERSION_INFO_MISSING`.
 *
 * Attached at BUILD time, via `TransactionRequestBuilder.withAuthArg`. An auth argument cannot be
 * set on a finished `TransactionRequest` — the SDK exposes only a getter, deliberately, because
 * miden-client keeps the auth arg mutually exclusive with the fee conversion salt and enforces
 * that on the builder. Every wallet-built request therefore threads this through its producer.
 *
 * Set as a plain auth arg + advice map, NOT via the SDK's `withFeeConversionSalt`: that form flags
 * the request as declaring conversion info, which makes the client classify the account's auth
 * component first — and it refuses a guarded multisig it cannot classify. The guardian package's
 * own typed proposals take this same route, and the kernel gets identical conversion info either way.
 *
 * MUST be called OUTSIDE `withWasmClientLock`. On a cache miss the reads below drive their own
 * `RpcClient` through the WASM module, and re-entering it under the client lock traps as a bare
 * `RuntimeError` and poisons the client.
 *
 * Both reads are network-dependent and both are caught: a transient RPC blip must not fail a
 * transaction. Returning `undefined` degrades to the pre-fee behaviour rather than throwing.
 */
export async function resolveBuildTimeFeeAuth(): Promise<FeeAuth | undefined> {
  let feeFaucetId: string;
  try {
    // ONLY skip on a POSITIVE zero. `null` is "not discovered yet", and attaching then is the
    // fail-open choice: the commitment is inert on a chain that charges nothing (miden-client
    // returns early before it is consulted) but load-bearing on one that does.
    if ((await getVerificationBaseFee()) === 0) {
      return undefined;
    }
    feeFaucetId = await getNativeAssetId();
  } catch (error) {
    console.warn('[fee-auth] could not read the chain fee parameters; building without it', error);
    return undefined;
  }
  // `accountRefToSdk(...).toString()`, not the raw id: the wallet's native-asset id is bech32 and
  // the guardian helper parses its argument as HEX, rejecting bech32 with "expected hex data to
  // have length 32 ... found 49". The shared resolver accepts both forms and re-emits hex.
  return resolveAuthArg(randomFeeSalt(), accountRefToSdk(feeFaucetId).toString());
}
