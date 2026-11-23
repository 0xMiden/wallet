import React, { useSyncExternalStore } from 'react';

import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { IconName } from 'app/icons/v2';
import { NetworkChip } from 'components/NetworkChip';
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
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline bg-fill/40 px-4 py-3 sm:px-8 lg:px-12 lg:py-5">
      <button
        type="button"
        className="flex shrink-0 items-center gap-2 rounded-lg text-title-tab text-ink focus-visible:outline-2 focus-visible:outline-accent-primary"
        onClick={() => navigate('/')}
      >
        <BreadLogo className="h-8 w-8" aria-hidden="true" />
        {t('appName')}
      </button>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:gap-3">
        {identityCurrent && account && network && (
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-body-sm text-muted">
            <span className="max-w-full truncate">{account.name}</span>
            <NetworkChip kind="miden" label={network.name} />
          </div>
        )}
        <Dialog.Trigger asChild>
          <IconButton icon={IconName.Search} label={t('commandSearch')} />
        </Dialog.Trigger>
      </div>
    </header>
  );
}
