import React, { useSyncExternalStore } from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { IconName } from 'app/icons/v2';
import { NetworkChip } from 'components/NetworkChip';
import { Button, ButtonVariant } from 'components/ui/Button';
import { IconButton } from 'components/ui/IconButton';
import type { AccountScope } from 'lib/miden-chain/account-scope';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { subscribeBridgeConfig } from 'lib/remote-config/runtime';
import { WalletStatus } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { navigate } from 'lib/woozie';

export function CommandHeader({ scope }: { scope: AccountScope }): React.ReactElement {
  const { t } = useTranslation();
  const account = useWalletStore(state => state.currentAccount);
  const ready = useWalletStore(state => state.status === WalletStatus.Ready);
  const networks = useWalletStore(state => state.networks);
  const scopeCurrent = useSyncExternalStore(
    subscribeBridgeConfig,
    () => scope.network === getEffectiveNetworkName() && scope.rpcUrl === getEffectiveRpcUrl()
  );
  const identityCurrent = ready && account?.publicKey === scope.accountId && scopeCurrent;
  const network = identityCurrent ? networks?.find(item => item.id === scope.network) : undefined;
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <button
          type="button"
          className="max-w-full truncate text-left text-title-tab text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
          onClick={() => navigate('/')}
        >
          {t('commandWallet')}
        </button>
        {identityCurrent && account && network && (
          <div className="flex max-w-full flex-wrap items-center gap-1 text-body-sm text-muted">
            <span className="max-w-full truncate">{account.name}</span>
            <NetworkChip kind="miden" label={network.name} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Dialog.Trigger asChild>
          <IconButton icon={IconName.Search} label={t('commandSearch')} />
        </Dialog.Trigger>
        <Button size="sm" variant={ButtonVariant.Secondary} iconLeft={IconName.User} onClick={() => navigate('/me')}>
          {t('profile')}
        </Button>
      </div>
    </header>
  );
}
