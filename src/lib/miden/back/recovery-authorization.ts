import { ITransaction } from 'lib/miden/db/types';
import type { GuardianRecoveryAction } from 'lib/shared/types';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface Authorization {
  binding: string;
  publicKey: string;
  secret: Uint8Array;
  active: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const authorizations = new Map<string, Authorization>();

export function isRecoveryTransaction(transaction: ITransaction): boolean {
  switch (transaction.type) {
    case 'switch-guardian':
    case 'replace-hot-key':
    case 'update-procedure-threshold':
      return true;
    default:
      return false;
  }
}

export function getRecoveryAction(transaction: ITransaction): GuardianRecoveryAction {
  const accountId = transaction.accountId;
  switch (transaction.type) {
    case 'replace-hot-key':
      return { type: transaction.type, accountId };
    case 'switch-guardian': {
      const endpoint = transaction.extraInputs?.newGuardianEndpoint;
      if (typeof endpoint !== 'string' || !endpoint) throw new Error('Invalid Guardian target');
      return { type: transaction.type, accountId, newGuardianEndpoint: endpoint };
    }
    case 'update-procedure-threshold': {
      const procedure = transaction.extraInputs?.procedure;
      const threshold = transaction.extraInputs?.threshold;
      if (typeof procedure !== 'string' || typeof threshold !== 'number')
        throw new Error('Invalid procedure threshold');
      return { type: transaction.type, accountId, procedure, threshold };
    }
    default:
      throw new Error('This action does not use a recovery key');
  }
}

function binding(transaction: ITransaction): string {
  return JSON.stringify(getRecoveryAction(transaction));
}

export function clearRecoveryAuthorization(transactionId: string): void {
  const authorization = authorizations.get(transactionId);
  if (!authorization) return;
  clearTimeout(authorization.timer);
  authorization.secret.fill(0);
  authorizations.delete(transactionId);
}

export function clearRecoveryAuthorizations(): void {
  for (const transactionId of authorizations.keys()) clearRecoveryAuthorization(transactionId);
}

export function authorizeRecovery(transaction: ITransaction, publicKey: string, secret: Uint8Array): void {
  clearRecoveryAuthorization(transaction.id);
  const timer = setTimeout(() => {
    const authorization = authorizations.get(transaction.id);
    if (!authorization?.active) clearRecoveryAuthorization(transaction.id);
  }, IDLE_TIMEOUT_MS);
  authorizations.set(transaction.id, { binding: binding(transaction), publicKey, secret, active: false, timer });
}

export function getRecoveryAuthorization(transaction: ITransaction, publicKey: string): Uint8Array | undefined {
  const authorization = authorizations.get(transaction.id);
  if (authorization?.binding !== binding(transaction) || authorization.publicKey !== publicKey) return undefined;
  return authorization.secret;
}

export function beginRecoveryAuthorization(transaction: ITransaction, publicKey: string): boolean {
  if (!getRecoveryAuthorization(transaction, publicKey)) return false;
  const authorization = authorizations.get(transaction.id);
  if (!authorization) return false;
  // Keep the key until the current pipeline stops. It can need several signatures.
  authorization.active = true;
  clearTimeout(authorization.timer);
  return true;
}
