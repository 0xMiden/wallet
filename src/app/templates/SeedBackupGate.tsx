import React, { FC, ReactNode, useEffect, useState } from 'react';

import BigNumber from 'bignumber.js';
import { useTranslation } from 'react-i18next';

import FullScreenPage from 'app/layouts/FullScreenPage';
import { AlertSheet } from 'components/ui/AlertSheet';
import { useStorage } from 'lib/miden/front/storage';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { tokenQuote } from 'lib/miden/swap/tokens';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
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
  const [reachedThisSession, setReachedThisSession] = useState(false);
  const reached = useWalletStore(reachesSeedBackupThreshold);
  const [required, setRequired] = useStorage<boolean>(SEED_BACKUP_REQUIRED_KEY, false);
  const [prompts] = useStorage<WalletPromptStorage>(WALLET_PROMPTS_STORAGE_KEY, EMPTY_WALLET_PROMPT_STORAGE);
  // A recovered phrase is already held outside this device. A removed phrase cannot be shown again.
  const exempt =
    getEffectiveNetworkName() !== MIDEN_NETWORK_NAME.MAINNET ||
    status !== WalletStatus.Ready ||
    ownMnemonic ||
    Boolean(seedStatus && seedStatus !== 'stored');
  const verified = prompts.prompts[WalletPromptType.VerifySeedPhrase] === WalletPromptStatus.Completed;

  useEffect(() => {
    if (reached && !exempt) setReachedThisSession(true);
  }, [reached, exempt]);

  useEffect(() => {
    if (!reachedThisSession || required || verified) return;
    let ignoreLateRejection = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      setRequired(true).catch(error => {
        if (ignoreLateRejection) return;
        console.warn('Could not save the seed backup requirement:', error);
        retryTimer = setTimeout(persist, 1000);
      });
    };
    persist();
    return () => {
      ignoreLateRejection = true;
      clearTimeout(retryTimer);
    };
  }, [reachedThisSession, required, verified, setRequired]);

  if (!exempt && !verified && (required || reached || reachedThisSession)) return <RequiredSeedBackup />;
  return <>{children}</>;
};

const RequiredSeedBackup: FC = () => {
  const { t } = useTranslation();
  const [started, setStarted] = useState(false);

  if (started) {
    return (
      <FullScreenPage entrance="fade">
        <VerifySeedPhraseFlow required />
      </FullScreenPage>
    );
  }

  return (
    <AlertSheet
      open
      dismissible={false}
      title={t('seedBackupRequiredTitle')}
      actionLabel={t('seedBackupRequiredAction')}
      onAction={() => setStarted(true)}
      screenKey="seed-backup-required"
      actionTestId="seed-backup-required-action"
    >
      {t('seedBackupRequiredBody')}
    </AlertSheet>
  );
};
