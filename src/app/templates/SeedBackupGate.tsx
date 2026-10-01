import React, { FC, ReactNode, useEffect, useState } from 'react';

import BigNumber from 'bignumber.js';

import FullScreenPage from 'app/layouts/FullScreenPage';
import { useStorage } from 'lib/miden/front/storage';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import type { WalletStore } from 'lib/store/types';
import {
  EMPTY_WALLET_PROMPT_STORAGE,
  WALLET_PROMPTS_STORAGE_KEY,
  WalletPromptStatus,
  WalletPromptStorage,
  WalletPromptType
} from 'lib/wallet-prompts';

import VerifySeedPhraseFlow from './VerifySeedPhraseFlow';

export const SEED_BACKUP_REQUIRED_KEY = 'seed_backup_required_v1';

export function reachesSeedBackupThreshold(state: Pick<WalletStore, 'accounts' | 'balances' | 'tokenPrices'>): boolean {
  let total = new BigNumber(0);
  const addresses = new Set(state.accounts.map(account => account.publicKey));
  for (const address of addresses) {
    for (const token of state.balances[address] ?? []) {
      if (!Number.isFinite(token.balance) || token.balance <= 0 || !hasKnownScale(token.metadata)) continue;
      const quote = tokenQuote(state.tokenPrices, token.tokenId, token.metadata.symbol);
      if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) continue;
      total = total.plus(new BigNumber(token.balance).times(quote.price));
    }
  }
  return total.gte(150);
}

export const SeedBackupGate: FC<{ children: ReactNode }> = ({ children }) => {
  const status = useWalletStore(s => s.status);
  const seedStatus = useWalletStore(s => s.seedPhraseStatus);
  const ownMnemonic = useWalletStore(s => s.ownMnemonic);
  // A recovered phrase is already held outside this device. A removed phrase cannot be shown again.
  if (status !== WalletStatus.Ready || ownMnemonic || (seedStatus && seedStatus !== 'stored')) return <>{children}</>;
  return <UnverifiedSeedGate>{children}</UnverifiedSeedGate>;
};

const UnverifiedSeedGate: FC<{ children: ReactNode }> = ({ children }) => {
  const [reachedThisSession, setReachedThisSession] = useState(false);
  const reached = useWalletStore(reachesSeedBackupThreshold);
  const [required, setRequired] = useStorage<boolean>(SEED_BACKUP_REQUIRED_KEY, false);
  const [prompts] = useStorage<WalletPromptStorage>(WALLET_PROMPTS_STORAGE_KEY, EMPTY_WALLET_PROMPT_STORAGE);
  const verified = prompts.prompts[WalletPromptType.VerifySeedPhrase] === WalletPromptStatus.Completed;

  useEffect(() => {
    if (reached) setReachedThisSession(true);
  }, [reached]);

  useEffect(() => {
    if (reachedThisSession && !required && !verified) {
      setRequired(true).catch(error => console.warn('Could not save the seed backup requirement:', error));
    }
  }, [reachedThisSession, required, verified, setRequired]);

  return (
    <>
      {!verified && (required || reached || reachedThisSession) ? (
        <FullScreenPage entrance="fade">
          <VerifySeedPhraseFlow required />
        </FullScreenPage>
      ) : (
        children
      )}
    </>
  );
};
