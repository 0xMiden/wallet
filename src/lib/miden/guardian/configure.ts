import type { GuardianHttpClient } from '@openzeppelin/guardian-client';
import type { DetectedMultisigConfig } from '@openzeppelin/miden-multisig-client';

/**
 * What one `/configure` registers: the account, the state the Guardian stores for it, and the cosigner commitments it
 * admits. Read under the WASM hold that produced the state, so registering it needs no client call.
 */
export interface GuardianRegistration {
  accountIdHex: string;
  stateBase64: string;
  signerCommitments: readonly string[];
}

/**
 * The signer facts `ecdsaCosigners` reads from `AccountInspector.fromAccount`. multisig-client 0.19 reports each
 * signer's scheme (`signers`) and the guardian's (`guardianScheme`, `null` when unread); 0.18.1 reports neither.
 */
export type CosignerRead = Pick<DetectedMultisigConfig, 'numSigners' | 'signerCommitments'> & {
  signers?: readonly { commitment: string; scheme: string }[];
  guardianScheme?: string | null;
};

/**
 * Register an account on `guardian`, which must already carry the signer that authenticates the request. The wallet's
 * accounts are ECDSA throughout, so the policy is always `MidenEcdsa`.
 *
 * Never touches the WASM client. multisig-client's `registerOnGuardian` reads the client store first from 0.19 on, and
 * every caller registers outside the hold (#1207).
 *
 * A refusal reaches the caller as the client's own error, so its retry loop still reads the status, the code and
 * `Retry-After`.
 */
export async function configureGuardianAccount(
  guardian: GuardianHttpClient,
  registration: GuardianRegistration
): Promise<void> {
  const response = await guardian.configure({
    accountId: registration.accountIdHex,
    auth: { MidenEcdsa: { cosigner_commitments: [...registration.signerCommitments] } },
    initialState: { data: registration.stateBase64, accountId: registration.accountIdHex }
  });
  // `!== true`: the client copies `success` straight off the response body, so `"false"` is a truthy string. The
  // server's message is logged, never thrown: a switch's error is persisted on the row and shown as wallet copy.
  if (response.success !== true) {
    console.warn('The guardian rejected the account registration:', response.message);
    throw new Error('The guardian rejected the account registration');
  }
}

const sameHex = (a: string, b: string | undefined): boolean => b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * The cosigner commitments to register for an account, from an `AccountInspector.fromAccount` read of it. That read
 * skips what it cannot parse, and the result becomes the Guardian's authorization policy for the account, so it is
 * refused unless it is complete: as many commitments as storage declares signers, above 0, each with a scheme read
 * for it. Every signer and the guardian must be ECDSA, the only policy `configureGuardianAccount` sends.
 *
 * A read with no scheme fields at all comes from multisig-client 0.18.1, which reads no schemes and whose own
 * registration sent the wallet signer's scheme unread; it is held to completeness alone.
 */
export function ecdsaCosigners(detected: CosignerRead): string[] {
  const { numSigners, signerCommitments } = detected;
  if (!(numSigners > 0) || signerCommitments.length !== numSigners) {
    throw new Error(
      `Refusing to register an incomplete signer set: storage declares ${numSigners} signers, ` +
        `read ${signerCommitments.length}`
    );
  }
  // A 0.18.1 read; this branch goes away when the Guardian clients move to 0.19.
  if (detected.signers === undefined && detected.guardianScheme === undefined) return [...signerCommitments];

  const signers = detected.signers ?? [];
  if (
    signers.length !== numSigners ||
    signers.some((signer, index) => !sameHex(signer.commitment, signerCommitments[index]))
  ) {
    throw new Error(
      `Refusing to register: read a scheme for ${signers.length} of ${numSigners} signers, or for other signers`
    );
  }
  if (signers.some(signer => signer.scheme !== 'ecdsa')) {
    throw new Error('Refusing to register a signer set that is not all ECDSA');
  }
  if (detected.guardianScheme !== 'ecdsa') {
    throw new Error(`Refusing to register: the guardian scheme reads ${detected.guardianScheme ?? 'nothing'}`);
  }
  return [...signerCommitments];
}
