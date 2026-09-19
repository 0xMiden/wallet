import React, { FC, useCallback, useEffect, useState } from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { useAccount } from 'lib/miden/front';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { resolvePublicKeyCommitments } from 'lib/miden/sdk/resolve-public-key-commitments';
import { hapticLight } from 'lib/mobile/haptics';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { navigate } from 'lib/woozie';
import { WalletType } from 'screens/onboarding/types';

const AdvancedSettings: FC = () => {
  const { t } = useTranslation();
  const walletAccount = useAccount();
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const { fieldRef, copy, copied } = useCopyToClipboard();
  const isGuardianAccount = walletAccount.type === WalletType.Guardian;

  const fetchPublicKey = useCallback(async () => {
    // Wrap WASM client operations in a lock to prevent concurrent access
    const key = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      const account = await midenClient.getAccount(walletAccount.publicKey);
      if (!account) {
        return null;
      }
      const publicKeyCommitments = resolvePublicKeyCommitments(account);
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

  const handleExportAccountFile = useCallback(() => {
    hapticLight();
    navigate('/settings/export-account-file');
  }, []);

  // Truncate to a chip-friendly form: 0x + first 6 + ... + last 4.
  // Until the WASM client resolves the key we render a non-breaking space so
  // the row keeps its height and doesn't jump on first paint.
  const truncatedPublicKey = publicKey ? `0x${publicKey.slice(0, 6)}...${publicKey.slice(-4)}` : ' ';

  return (
    <div className="w-full flex flex-col gap-6 pb-6">
      <div className="flex items-center justify-between text-ink">
        <div className="flex flex-col">
          <span className="font-medium text-base">{t('accountPublicKey')}</span>
          {/* `text-ink`, not `text-text-muted` (#ababab, 2.30:1 in light):
              this is a public key the user is meant to read and copy, at 12px. */}
          <span className="text-xs font-mono text-ink select-text">{truncatedPublicKey}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!publicKey}
          className="flex items-center cursor-pointer hover:bg-fill-pressed disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Icon name={copied ? IconName.Checkmark : IconName.Copy} className={clsx('w-5 h-5 p-1 stroke-ink')} />
        </button>
      </div>

      <button type="button" onClick={() => navigate('/settings/edit-miden-faucet-id')} className="w-full">
        <div className="flex items-center justify-between text-ink">
          <div className="flex flex-col">
            <span className="font-medium text-base">{t('editMidenFaucetId')}</span>
          </div>
          <Icon name={IconName.ChevronRightLucide} className="w-5 h-5 stroke-ink" fill="none" />
        </div>
      </button>

      {/* A Guardian account can never be exported: its auth entry is a platform-wrapped hot
          ciphertext, and the vault refuses it outright. Do not offer the action rather than let
          the user acknowledge the warning and spend a credential to reach a certain refusal. */}
      {!isGuardianAccount && (
        <button type="button" onClick={handleExportAccountFile} className="w-full">
          <div className="flex items-center justify-between text-heading-gray">
            <div className="flex flex-col">
              <span className="font-medium text-base">{t('exportAccountFile')}</span>
            </div>
            <Icon name={IconName.ChevronRightLucide} className="w-5 h-5 stroke-black" fill="none" />
          </div>
        </button>
      )}

      <input ref={fieldRef} value={publicKey ?? ''} readOnly className="sr-only" />
    </div>
  );
};

export default AdvancedSettings;
