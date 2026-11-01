import type { RecoveryAccountExpectation, RecoveryJournalSnapshot, RecoveryScope } from './types';

export interface WalletStoreGeneration {
  id: 'generation';
  generation: string;
  origin: 'fresh' | 'migrated' | 'authorized';
}
export interface ContinuityInput {
  previous?: RecoveryJournalSnapshot;
  accountIds: string[];
  network: string;
  wallet: WalletStoreGeneration | undefined;
  sdkGeneration: string | null;
  readAccount: (id: string) => Promise<RecoveryAccountExpectation | null>;
  establish?: boolean;
}
export interface ContinuityResult {
  scope: RecoveryScope;
  accounts: RecoveryAccountExpectation[];
}
export class StorageContinuityError extends Error {
  constructor() {
    super('Storage continuity unavailable');
    this.name = 'StorageContinuityError';
  }
}
export async function checkContinuity(input: ContinuityInput): Promise<ContinuityResult> {
  const { previous, accountIds, network, wallet, sdkGeneration, readAccount, establish } = input;
  if (!wallet || accountIds.length === 0 || accountIds.length > 256 || new Set(accountIds).size !== accountIds.length)
    throw new StorageContinuityError();
  if (previous) {
    if (
      previous.scope.network !== network ||
      previous.scope.walletGeneration !== wallet.generation ||
      previous.scope.sdkGeneration !== sdkGeneration ||
      previous.accounts.some(account => !accountIds.includes(account.accountId))
    )
      throw new StorageContinuityError();
  } else if (!establish && (wallet.origin !== 'migrated' || sdkGeneration !== null)) throw new StorageContinuityError();
  const accounts: RecoveryAccountExpectation[] = [];
  for (const id of accountIds) {
    const account = await readAccount(id);
    const floor = previous?.accounts.find(expected => expected.accountId === id);
    if (
      !account ||
      account.accountId !== id ||
      !/^(0|[1-9]\d{0,19})$/.test(account.nonce) ||
      !account.commitment ||
      (floor &&
        (BigInt(account.nonce) < BigInt(floor.nonce) ||
          (account.nonce === floor.nonce && account.commitment !== floor.commitment)))
    )
      throw new StorageContinuityError();
    accounts.push(account);
  }
  return {
    scope: { network, walletGeneration: wallet.generation, sdkGeneration: sdkGeneration ?? crypto.randomUUID() },
    accounts
  };
}
