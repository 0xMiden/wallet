import { SigningInputs, SigningInputsType, type TransactionSummary } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import { summaryToView } from 'app/confirm/decode';
import { getMessage } from 'lib/i18n/core';
import { isVerificationBaseFeeKnownAbsent, refreshVerificationBaseFee } from 'lib/miden-chain/native-asset';

import { ProposalFeeUnknownError } from './constants';
import { assertCachedViewEffectApproved, effectRefusal, isEffectChecked } from './proposal-effect-guard';
import type { ITransaction } from '../db/types';
import { canonicalWalletAccountId, getBech32AddressFromAccountId } from '../sdk/helpers';
import { isIndefiniteSubmitOutcomeError, isKilledPipeline } from '../sdk/sdk-error-code';

/** A keystore signer as the wallet's signing paths take it: hex public key and hex `SigningInputs` in, signature out. */
export type RawSigner = (publicKey: string, signingInputs: string) => Promise<Uint8Array>;

/** Throws why `transaction`'s write may not sign `signingInputsHex`. */
async function assertSignable(transaction: ITransaction, signingInputsHex: string): Promise<void> {
  let inputs: SigningInputs | undefined;
  let summary: TransactionSummary | undefined;
  // Set when a trap is already the pending rejection, so `free` cannot replace it.
  let trap: WebAssembly.RuntimeError | undefined;
  const rethrowTrap = (error: unknown): void => {
    if (!(error instanceof WebAssembly.RuntimeError)) return;
    trap = error;
    throw error;
  };
  try {
    let account: string | undefined;
    try {
      inputs = SigningInputs.deserialize(new Uint8Array(Buffer.from(signingInputsHex, 'hex')));
      if (inputs.variantType === SigningInputsType.TransactionSummary) {
        summary = inputs.transactionSummaryPayload();
        // Spelled as the decoder spells `view.account`, so it folds to the same id as the row's account.
        account = canonicalWalletAccountId(getBech32AddressFromAccountId(summary.accountDelta().id()));
      }
    } catch (error) {
      rethrowTrap(error);
      throw effectRefusal(transaction, 'the transaction summary could not be read', error);
    }
    // A checked write signs only its own summary.
    if (summary === undefined) throw effectRefusal(transaction, 'the signature asked for is not a transaction summary');
    if (account !== canonicalWalletAccountId(transaction.accountId)) {
      throw effectRefusal(transaction, 'the summary is for another account');
    }
    const signed = summary;
    try {
      await assertCachedViewEffectApproved(transaction, () => summaryToView(signed));
    } catch (error) {
      rethrowTrap(error);
      throw error;
    }
  } finally {
    // Both hold WASM memory until freed; optional because not every binding declares `free`.
    // `free` on a trapped module can throw, and a finally throw would replace the pending trap.
    for (const value of [summary, inputs]) {
      try {
        value?.free?.();
      } catch (error) {
        if (trap === undefined) throw error;
      }
    }
  }
}

/**
 * Run `transaction`'s write with a signer of its own that refuses to sign a summary moving more than the row was
 * approved to move, then delegates to `sign`. The check belongs to this write's signer, not to its account, so a
 * dry run or another write of the same account signing meanwhile is never judged against this row.
 *
 * The SDK forwards only a refused signer's message, and a caller may swallow it, so once a check fails the signer
 * refuses everything after it and the write rejects with that first error, the same instance, when `run` resolves or
 * rejects with an ordinary error. A killed pipeline or an indefinite submit from `run` is thrown instead, the same
 * abandoned-write class the Guardian arms use: a recorded fee refusal, effect refusal or trap does not replace it.
 * A type the check does not cover runs with `sign` itself.
 *
 * The signer runs inside the SDK's sign callback, which on the inline path holds the WASM client lock, so it decodes
 * the inputs on their own, as `Vault.signTransaction` does, and never takes the lock.
 */
export async function withEffectCheckedSigner<T>(
  transaction: ITransaction,
  sign: RawSigner,
  run: (signer: RawSigner) => Promise<T>
): Promise<T> {
  if (!isEffectChecked(transaction.type)) return run(sign);
  // The fee is read from the chain here, before the write, and the signer reads the cache this read filled: the
  // signer runs inside the WASM hold, where a network read cannot wait.
  const chainFee = await refreshVerificationBaseFee();
  if (chainFee === null && !isVerificationBaseFeeKnownAbsent())
    throw new ProposalFeeUnknownError(getMessage('chainFeeUnknown'));
  const check: { failed?: { error: unknown } } = {};
  const refuseAfterFailure = (): void => {
    if (check.failed) throw check.failed.error;
  };
  const signer: RawSigner = async (publicKey, signingInputs) => {
    refuseAfterFailure();
    try {
      await assertSignable(transaction, signingInputs);
    } catch (error) {
      check.failed ??= { error };
      throw error;
    }
    // Asked again: a sibling sign of this write can fail while this one waits on its check.
    refuseAfterFailure();
    return sign(publicKey, signingInputs);
  };
  let result: T;
  try {
    result = await run(signer);
  } catch (error) {
    // The abandoned-write class the Guardian arms use outranks a recorded refusal. Anything else still throws it.
    if (isKilledPipeline(error) || isIndefiniteSubmitOutcomeError(error)) throw error;
    if (check.failed) throw check.failed.error;
    throw error;
  }
  if (check.failed) throw check.failed.error;
  return result;
}
