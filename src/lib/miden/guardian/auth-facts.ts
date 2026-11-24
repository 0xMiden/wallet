import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';
import {
  annotateCrash,
  errorChain,
  type GuardianSignerInSet,
  type GuardianSigningKey,
  type HotKeyRotationPending
} from 'lib/telemetry/crash-diagnostics';

/**
 * Structural GuardianHttpError auth-rejection check (401 /
 * `authentication_failed` / `signer_not_authorized`). Duck-typed rather than
 * `instanceof GuardianHttpError` so it survives test mocks of the multisig
 * client and any duplicate-package instance of the error class (same
 * convention as the 409 check in `./serialize.ts`).
 */
export const isGuardianAuthRejection = (err: unknown): boolean => {
  if (typeof err !== 'object' || err === null) return false;
  const status = 'status' in err ? err.status : undefined;
  const code = 'code' in err ? err.code : undefined;
  return status === 401 || code === 'authentication_failed' || code === 'signer_not_authorized';
};

export type GuardianAuthFacts = {
  guardianSignerInSet: GuardianSignerInSet;
  guardianSigningKey: GuardianSigningKey;
  hotKeyRotationPending: HotKeyRotationPending;
};

/**
 * What a Guardian authentication refusal cannot say on its own: whether the key this device signs with commits to one
 * of the account's signers on chain. The Guardian checks the signing key against its own copy of that set, so "no"
 * points at the key this device signs with, and "yes" at the Guardian's copy.
 */
export async function readGuardianAuthFacts(
  signerPublicKeyHex: string,
  onChainCommitments: readonly string[],
  signingKey: GuardianSigningKey,
  rotationPending: boolean
): Promise<GuardianAuthFacts> {
  let guardianSignerInSet: GuardianSignerInSet = 'unknown';
  if (onChainCommitments.length > 0) {
    try {
      const signing = await commitmentFromPublicKeyHex(signerPublicKeyHex);
      guardianSignerInSet = onChainCommitments.some(commitment => sameCommitment(commitment, signing)) ? 'yes' : 'no';
    } catch {
      // A key that does not decode leaves the answer unknown rather than costing the request.
    }
  }
  return { guardianSignerInSet, guardianSigningKey: signingKey, hotKeyRotationPending: rotationPending ? 'yes' : 'no' };
}

/** Awaits `operation` and rethrows its rejection unchanged, naming `facts` on it when the Guardian refused to authenticate. */
export async function withGuardianAuthFacts<T>(
  facts: GuardianAuthFacts | undefined,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (facts !== undefined && errorChain(error).some(isGuardianAuthRejection)) annotateCrash(error, facts);
    throw error;
  }
}
