import React, { FC, useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { useAccount } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { hapticLight } from 'lib/mobile/haptics';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { navigate } from 'lib/woozie';

const AdvancedSettings: FC<{ onClose?: () => void }> = ({ onClose }) => {
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
      return publicKeyCommitments[0]!.toHex().slice(2);
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

  // Truncate to a chip-friendly form: 0x + first 6 + ... + last 4.
  // Until the WASM client resolves the key we render a non-breaking space so
  // the row keeps its height and doesn't jump on first paint.
  const truncatedPublicKey = publicKey ? `0x${publicKey.slice(0, 6)}...${publicKey.slice(-4)}` : ' ';

  return (
    <div className="w-full flex flex-col gap-6 pb-6">
      <div className="flex items-center justify-between text-heading-gray">
        <div className="flex flex-col">
          <span className="font-medium text-base">{t('accountPublicKey')}</span>
          <span className="text-xs font-mono text-text-muted select-text">{truncatedPublicKey}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!publicKey}
          className="flex items-center cursor-pointer hover:bg-gray-25 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Icon name={copied ? IconName.Checkmark : IconName.Copy} className={clsx('w-5 h-5 p-1 stroke-black')} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => {
          onClose?.();
          navigate('/settings/edit-miden-faucet-id');
        }}
        className="w-full"
      >
        <div className="flex items-center justify-between text-heading-gray">
          <div className="flex flex-col">
            <span className="font-medium text-base">{t('editMidenFaucetId')}</span>
          </div>
          <Icon name={IconName.ChevronRightLucide} className="w-5 h-5 stroke-black" fill="none" />
        </div>
      </button>

      <input ref={fieldRef} value={publicKey ?? ''} readOnly className="sr-only" />
    </div>
  );
};

export default AdvancedSettings;
