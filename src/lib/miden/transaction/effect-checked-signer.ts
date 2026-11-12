import { SigningInputs, SigningInputsType, type TransactionSummary } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import { summaryToView } from 'app/confirm/decode';
import { getVerificationBaseFee } from 'lib/miden-chain/native-asset';

import { assertViewEffectApproved, effectRefusal, isEffectChecked } from './proposal-effect-guard';
import type { ITransaction } from '../db/types';
import { canonicalWalletAccountId, getBech32AddressFromAccountId } from '../sdk/helpers';

/** A keystore signer as the wallet's signing paths take it: hex public key and hex `SigningInputs` in, signature out. */
export type RawSigner = (publicKey: string, signingInputs: string) => Promise<Uint8Array>;

/** The summary `signingInputsHex` asks to sign, with its account's canonical id; undefined for any other variant. */
function readSignedSummary(signingInputsHex: string): { summary: TransactionSummary; account: string } | undefined {
  const inputs = SigningInputs.deserialize(new Uint8Array(Buffer.from(signingInputsHex, 'hex')));
  if (inputs.variantType !== SigningInputsType.TransactionSummary) return undefined;
  const summary = inputs.transactionSummaryPayload();
  // Spelled as the decoder spells `view.account`, so it folds to the same id as the row's account.
  return { summary, account: canonicalWalletAccountId(getBech32AddressFromAccountId(summary.accountDelta().id())) };
}

/** Throws why `transaction`'s write may not sign `signingInputsHex`. */
async function assertSignable(transaction: ITransaction, signingInputsHex: string): Promise<void> {
  let signed: ReturnType<typeof readSignedSummary>;
  try {
    signed = readSignedSummary(signingInputsHex);
  } catch (error) {
    throw effectRefusal(transaction, 'the transaction summary could not be read', error);
  }
  // A checked write signs only its own summary.
  if (signed === undefined) throw effectRefusal(transaction, 'the signature asked for is not a transaction summary');
  if (signed.account !== canonicalWalletAccountId(transaction.accountId)) {
    throw effectRefusal(transaction, 'the summary is for another account');
  }
  const { summary } = signed;
  await assertViewEffectApproved(transaction, () => summaryToView(summary));
}

/**
 * Run `transaction`'s write with a signer of its own that refuses to sign a summary moving more than the row was
 * approved to move, then delegates to `sign`. The check belongs to this write's signer, not to its account, so a
 * dry run or another write of the same account signing meanwhile is never judged against this row.
 *
 * The SDK forwards only a refused signer's message, and a caller may swallow it, so once a check fails the signer
 * refuses everything after it and the write rejects with that first error, the same instance, whether `run` resolved
 * or not. A type the check does not cover runs with `sign` itself.
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
  // Looked up here, outside any lock, so the check reads a cached fee rather than waiting on the node inside the
  // write's hold. Only the check judges the answer, and a failure here only leaves it to look again.
  await getVerificationBaseFee().catch(() => null);
  const check: { failed?: { error: unknown } } = {};
  const signer: RawSigner = async (publicKey, signingInputs) => {
    if (check.failed) throw check.failed.error;
    try {
      await assertSignable(transaction, signingInputs);
    } catch (error) {
      check.failed ??= { error };
      throw error;
    }
    return sign(publicKey, signingInputs);
  };
  let result: T;
  try {
    result = await run(signer);
  } catch (error) {
    if (check.failed) throw check.failed.error;
    throw error;
  }
  if (check.failed) throw check.failed.error;
  return result;
}
