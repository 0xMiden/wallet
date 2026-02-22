import React, { FC, useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { IconName } from 'app/icons/v2';
import HashChip from 'app/templates/HashChip';
import { ListItem } from 'components/ListItem';
import { useAccount } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isMobile } from 'lib/platform';
import { bytesToHex } from 'lib/shared/helpers';
import { Link } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

const AdvancedSettings: FC = () => {
  const { t } = useTranslation();
  const walletAccount = useAccount();
  const faucetId = useMidenFaucetId();
  const faucetIdShortened = truncateAddress(faucetId, false);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  const fetchPublicKey = useCallback(async () => {
    // Wrap WASM client operations in a lock to prevent concurrent access
    const key = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      const account = await midenClient.getAccount(walletAccount.publicKey);
      if (!account) {
        return null;
      }
      const publicKeyCommitments = account.getPublicKeyCommitments();
      if (publicKeyCommitments.length === 0) {
        return null;
      }
      return publicKeyCommitments[0].toHex().slice(2);
    });
    setPublicKey(key);
  }, [walletAccount.publicKey]);

  useEffect(() => {
    fetchPublicKey();
  }, [fetchPublicKey]);

  return (
    <div className="flex justify-center py-6 text-heading-gray">
      <div className="flex flex-col w-[328px] gap-y-4">
        <div className="flex flex-row gap-x-2 px-2 justify-between">
          <span className={clsx('py-1 font-medium', isMobile() ? 'text-[20px] leading-5' : 'text-sm')}>
            {t('accountPublicKey')}
          </span>
          <HashChip hash={publicKey || ''} small={false} trimHash={true} />
        </div>
        <Link to={'settings/edit-miden-faucet-id'}>
          <ListItem
            title={t('editMidenFaucetId')}
            iconRight={IconName.ChevronRight}
            titleClassName={clsx('py-1 font-medium', isMobile() ? 'text-[20px] leading-5' : 'text-sm')}
          />
        </Link>
      </div>
    </div>
  );
};

export default AdvancedSettings;
