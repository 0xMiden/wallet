import { extractSdkErrorCode } from 'lib/miden/sdk/sdk-error-code';

/**
 * True for the SDK's "this transaction executed successfully, so there is nothing
 * pending authorization to summarize" rejection.
 *
 * web-sdk 0.16 inverted `executeForSummary`'s contract: the summary now exists
 * ONLY while authorization is pending (a multisig below threshold), and a
 * transaction that executes successfully rejects with code
 * `TRANSACTION_ALREADY_AUTHORIZED`, which is every ORDINARY single-sig account.
 * 0.15 did the opposite ("If the transaction succeeds, constructs a summary from
 * the executed transaction"). The code is carried as an error property in the
 * browser and prefixed onto the message on Node, so both are matched.
 */
export function isAlreadyAuthorizedError(err: unknown): boolean {
  if (extractSdkErrorCode(err) === 'TRANSACTION_ALREADY_AUTHORIZED') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('TRANSACTION_ALREADY_AUTHORIZED') || message.includes('already fully authorized');
}

/**
 * True when `executeForSummaryAtTip` died because it had no signer for this account, rather than
 * because the request itself is bad.
 *
 * Matched narrowly because the SDK reports signing failures as kernel event errors
 * without a code. Other execution failures must not enter the local fallback.
 */
export function isSummarySigningUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('failed to generate signature') || message.includes('Failed to get secret key');
}

/**
 * Missing fee-faucet context can use the same local execution fallback as a
 * missing signer; the wallet client already has the network's faucet.
 */
export function isSummaryFeeFaucetMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('no fee faucet is known') || message.includes('pass `feeFaucetId`');
}
