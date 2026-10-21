import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { assertWalletAccessAllowed } from 'lib/remote-config/wallet-access';
import { canonicalGuardianEndpoint } from 'lib/settings/helpers';
import { type GuardianHotKeySwapScope, type WalletAccount, WalletStatus } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { PublicError } from './defaults';
import { store } from './store';
import type { Vault } from './vault';
import { resolveGuardianEndpoint } from '../guardian/account';
import { isRealmKeystoreInstalled } from '../sdk/miden-client';
import { currentGuardianWriteGeneration } from '../sync-backoff';

function bindingOf(account: WalletAccount): string {
  return JSON.stringify([
    account.publicKey,
    account.type,
    account.hotPublicKey ?? null,
    account.coldPublicKey ?? null,
    canonicalGuardianEndpoint(resolveGuardianEndpoint(account)),
    account.guardianEpoch ?? 0
  ]);
}

export function createHotKeySwapGuard(
  vault: Vault,
  accountPublicKey: string,
  newHotPublicKey: string,
  expectedScope?: GuardianHotKeySwapScope
): (storedAccount?: WalletAccount) => void {
  const admitted = store.getState().accounts.find(account => account.publicKey === accountPublicKey);
  if (!admitted || admitted.type !== WalletType.Guardian) throw new PublicError('Guardian account is unavailable');
  const accountBinding = bindingOf(admitted);
  const admittedHotPublicKey = admitted.hotPublicKey;
  const network = getEffectiveNetworkName();
  const rpcUrl = getEffectiveRpcUrl();
  const generation = currentGuardianWriteGeneration();
  if (
    expectedScope !== undefined &&
    (!expectedScope ||
      typeof expectedScope.guardianEndpoint !== 'string' ||
      canonicalGuardianEndpoint(expectedScope.guardianEndpoint) !==
        canonicalGuardianEndpoint(resolveGuardianEndpoint(admitted)) ||
      expectedScope.guardianEpoch !== (admitted.guardianEpoch ?? 0) ||
      expectedScope.network !== network ||
      expectedScope.rpcUrl !== rpcUrl)
  ) {
    throw new PublicError('The admitted Guardian account binding changed');
  }
  const assertCurrent = (storedAccount?: WalletAccount) => {
    assertWalletAccessAllowed();
    const state = store.getState();
    if (
      !state.inited ||
      state.status !== WalletStatus.Ready ||
      state.vault !== vault ||
      !isRealmKeystoreInstalled({ insertKey: vault.insertKeySink })
    ) {
      throw Object.assign(new PublicError('Wallet is locked'), { reason: 'locked' });
    }
    const current = state.accounts.find(account => account.publicKey === accountPublicKey);
    if (
      network !== getEffectiveNetworkName() ||
      rpcUrl !== getEffectiveRpcUrl() ||
      generation !== currentGuardianWriteGeneration() ||
      !current ||
      bindingOf(current) !== accountBinding ||
      (storedAccount !== undefined &&
        bindingOf(storedAccount) !== accountBinding &&
        !(
          storedAccount.hotPublicKey === newHotPublicKey &&
          bindingOf({ ...storedAccount, hotPublicKey: admittedHotPublicKey }) === accountBinding
        ))
    ) {
      throw new PublicError('The hot-key update belongs to a retired account or network');
    }
  };
  assertCurrent();
  return assertCurrent;
}
