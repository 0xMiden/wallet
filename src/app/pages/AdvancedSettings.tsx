import React, { FC, useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { Icon, IconName } from 'app/icons/v2';
import { ListItem } from 'components/ListItem';
import { useAccount } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { hapticLight } from 'lib/mobile/haptics';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { Link } from 'lib/woozie';
import { truncateAddress } from 'utils/string';

const AdvancedSettings: FC = () => {
  const { t } = useTranslation();
  const walletAccount = useAccount();
  const faucetId = useMidenFaucetId();
  const faucetIdShortened = truncateAddress(faucetId, false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const { fieldRef, copy, copied } = useCopyToClipboard();

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

  const handleCopy = useCallback(() => {
    if (!publicKey) return;
    hapticLight();
    copy();
  }, [publicKey, copy]);

  return (
    <div className="py-6 text-heading-gray w-full">
      <div className="flex flex-col gap-y-2">
        <div className="flex flex-row gap-x-2 px-2 justify-between">
          <span className={clsx('font-medium', 'text-base')}>{t('accountPublicKey')}</span>
          <button type="button" onClick={handleCopy} className="flex items-center cursor-pointer hover:bg-gray-25">
            <Icon
              name={copied ? IconName.Checkmark : IconName.Copy}
              fill={copied ? 'green' : 'black'}
              className={clsx('w-5 h-5', 'p-1')}
            />
          </button>
        </div>
        <Link to={'settings/edit-miden-faucet-id'}>
          <ListItem
            title={t('editMidenFaucetId')}
            iconRight={IconName.ChevronRight}
            titleClassName={clsx('font-medium', 'text-[16px]')}
            className="w-full justify-between p-0 px-2"
            iconRightClassName="px-[9px] py-[6px]"
          />
        </Link>
      </div>
      <input ref={fieldRef} value={publicKey ?? ''} readOnly className="sr-only" />
    </div>
  );
};

export default AdvancedSettings;
