import { Account, type MidenClient } from '@miden-sdk/miden-sdk/lazy';

import { sameCommitment } from 'lib/secure-hot-key/commitment';

import { StorageContinuityError } from './continuity';
import { JOURNAL_MAX_BYTES } from './journal';
import type { RecoveryAccountExpectation } from './types';
import { isRecoveryAccount } from './validation';
import { getGuardianCommitmentFromAccount, getSignerCommitmentsFromAccount } from '../guardian/account';
import { sameWalletAccountId } from '../sdk/helpers';

export interface RecoveryAccountMaterial {
  floor: RecoveryAccountExpectation;
  accountBytes: Uint8Array;
  guardianCommitment: string;
  signerCommitments: string[];
  chainCommitment: string;
}

export interface RecoveryAccountClient {
  accounts: Pick<MidenClient['accounts'], 'get' | 'insert'>;
}

export async function restoreRetainedGuardianAccount(
  client: RecoveryAccountClient,
  material: RecoveryAccountMaterial,
  assertCurrent: () => void
): Promise<void> {
  assertCurrent();
  if (
    !isRecoveryAccount(material.floor) ||
    !(material.accountBytes instanceof Uint8Array) ||
    material.accountBytes.length === 0 ||
    material.accountBytes.length > JOURNAL_MAX_BYTES ||
    !material.guardianCommitment ||
    !material.chainCommitment ||
    material.signerCommitments.length === 0 ||
    material.signerCommitments.length > 2
  )
    throw new StorageContinuityError();
  const account = Account.deserialize(material.accountBytes);
  try {
    const candidate = describe(account, material.floor.accountId);
    const operator = getGuardianCommitmentFromAccount(account);
    const signers = getSignerCommitmentsFromAccount(account);
    const undeployed = /^(?:0x)?0+$/.test(material.chainCommitment);
    if (
      !operator ||
      !sameCommitment(operator, material.guardianCommitment) ||
      material.signerCommitments.some(expected => !signers.some(signer => sameCommitment(signer, expected))) ||
      (undeployed
        ? candidate.nonce !== '0' ||
          material.floor.nonce !== '0' ||
          !sameCommitment(candidate.commitment, material.floor.commitment)
        : !sameCommitment(candidate.commitment, material.chainCommitment))
    )
      throw new StorageContinuityError();
    assertAtLeast(candidate, material.floor);
    const existing = await client.accounts.get(material.floor.accountId);
    assertCurrent();
    if (existing) {
      const current = describe(existing, material.floor.accountId);
      assertAtLeast(candidate, current);
      if (candidate.nonce === current.nonce) return;
    }
    assertCurrent();
    await client.accounts.insert({ account, overwrite: true });
    assertCurrent();
    const adopted = await client.accounts.get(material.floor.accountId);
    assertCurrent();
    if (!adopted) throw new StorageContinuityError();
    const readback = describe(adopted, material.floor.accountId);
    if (readback.nonce !== candidate.nonce || !sameCommitment(readback.commitment, candidate.commitment))
      throw new StorageContinuityError();
  } finally {
    account.free();
  }
}

function describe(account: Account, accountId: string): RecoveryAccountExpectation {
  if (!sameWalletAccountId(account.id().toString(), accountId)) throw new StorageContinuityError();
  const commitment = account.to_commitment();
  try {
    return { accountId, nonce: account.nonce().asInt().toString(), commitment: commitment.toHex() };
  } finally {
    commitment.free();
  }
}

function assertAtLeast(candidate: RecoveryAccountExpectation, floor: RecoveryAccountExpectation): void {
  if (
    BigInt(candidate.nonce) < BigInt(floor.nonce) ||
    (candidate.nonce === floor.nonce && !sameCommitment(candidate.commitment, floor.commitment))
  )
    throw new StorageContinuityError();
}
