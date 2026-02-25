import React, { FC, useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { useAccount } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { hapticLight } from 'lib/mobile/haptics';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { Link } from 'lib/woozie';

const AdvancedSettings: FC = () => {
  const { t } = useTranslation();
  const walletAccount = useAccount();
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
    <div className="w-full max-w-sm mx-auto my-8 flex flex-col gap-3">
      <div className="border border-border-card rounded-5 p-4">
        <div className="flex items-center justify-between">
          <div className="flex flex-col pr-4">
            <span className="font-medium text-sm text-[#0F131A]">{t('accountPublicKey')}</span>
            <span className="text-xs text-[#555D6D] mt-1">{t('accountPublicKeyDescription')}</span>
          </div>
          <button type="button" onClick={handleCopy} className="flex items-center cursor-pointer hover:bg-gray-25">
            <Icon
              name={copied ? IconName.Checkmark : IconName.Copy}
              fill={copied ? 'green' : 'black'}
              className={clsx('w-5 h-5', 'p-1')}
            />
          </button>
        </div>
      </div>

      <Link to={'settings/edit-miden-faucet-id'}>
        <div className="border border-border-card rounded-5 p-4">
          <div className="flex items-center justify-between">
            <div className="flex flex-col pr-4">
              <span className="font-medium text-sm text-[#0F131A]">{t('editMidenFaucetId')}</span>
              <span className="text-xs text-[#555D6D] mt-1">{t('editMidenFaucetIdDescription')}</span>
            </div>
            <Icon name={IconName.ChevronRight} className="w-5 h-5 text-[#555D6D]" />
          </div>
        </div>
      </Link>

      <input ref={fieldRef} value={publicKey ?? ''} readOnly className="sr-only" />
    </div>
  );
};

export default AdvancedSettings;
