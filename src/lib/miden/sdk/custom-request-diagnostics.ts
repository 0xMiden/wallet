import { FeltArray, type MidenClient, Poseidon2, type TransactionRequest, Word } from '@miden-sdk/miden-sdk/lazy';
import { getProcedureRoot } from '@openzeppelin/miden-multisig-client';

import type { TransactionFailureDiagnostics } from 'lib/telemetry/transaction-failure';

type AuthDiagnostics = Pick<TransactionFailureDiagnostics, 'authLayout' | 'commitmentMatch'>;

/** Derive closed categories locally; never return authentication values or their hashes. */
export function customRequestAuthDiagnostics(
  request: TransactionRequest,
  observe?: (state: 'present' | 'absent' | 'read_failed') => void
): AuthDiagnostics {
  let authLayout: AuthDiagnostics['authLayout'] = 'unavailable';
  try {
    const auth = request.authArg();
    observe?.(auth === undefined ? 'absent' : 'present');
    if (auth === undefined) return { authLayout: 'absent', commitmentMatch: 'unavailable' };
    const values = request.adviceMap().get(auth);
    if (values === undefined) return { authLayout: 'missing_preimage', commitmentMatch: 'unavailable' };
    authLayout = values.length === 8 ? 'fee' : values.length === 12 ? 'guardian' : 'other';
    if (authLayout === 'other') return { authLayout, commitmentMatch: 'unavailable' };

    // fee.rs commits [INFO, SALT]; MultisigAuthArgs commits [BLOCK, SALT, INFO].
    const input = authLayout === 'fee' ? [...values.slice(4), ...values.slice(0, 4)] : values;
    const digest = Poseidon2.hashElements(new FeltArray(input));
    try {
      const commitment = auth.toU64s();
      const matches = digest.toU64s().every((value, index) => value === commitment[index]);
      return { authLayout, commitmentMatch: matches ? authLayout : 'neither' };
    } finally {
      digest.free?.();
    }
  } catch {
    observe?.('read_failed');
    return { authLayout, commitmentMatch: 'unavailable' };
  }
}

/** Recognize only the installed SDK's public Guardian procedure root, using the local store. */
export async function customRequestAccountAuthCode(
  client: MidenClient,
  account: string
): Promise<NonNullable<TransactionFailureDiagnostics['accountAuthCode']>> {
  try {
    const stored = await client.accounts.get(account);
    if (stored === null) return 'unavailable';
    const code = stored.code();
    // hasProcedure consumes its Word in the WASM bindings; transfer a fresh owner.
    return code.hasProcedure(Word.fromHex(getProcedureRoot('auth_tx'))) ? 'current_guardian' : 'unrecognized';
  } catch {
    return 'unavailable';
  }
}
