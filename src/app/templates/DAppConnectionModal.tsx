import React, { FC, useCallback, useMemo } from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { useTranslation } from 'react-i18next';

import FormSecondaryButton from 'app/atoms/FormSecondaryButton';
import FormSubmitButton from 'app/atoms/FormSubmitButton';
import { Icon, IconName } from 'app/icons/v2';
import { DAppConfirmationRequest, DAppConfirmationResult } from 'lib/dapp-browser/confirmation-store';
import { useWalletStore } from 'lib/store';

interface DAppConnectionModalProps {
  request: DAppConfirmationRequest;
  onResult: (result: DAppConfirmationResult) => void;
}

const DAppConnectionModal: FC<DAppConnectionModalProps> = ({ request, onResult }) => {
  const { t } = useTranslation();
  const currentAccount = useWalletStore(s => s.currentAccount);
  const accounts = useWalletStore(s => s.accounts);

  // Use current account or fallback to first account
  // Note: account objects use 'publicKey' not 'accountId'
  const accountId = useMemo(() => {
    if (currentAccount?.publicKey) return currentAccount.publicKey;
    if (accounts && accounts.length > 0) return accounts[0].publicKey;
    return null;
  }, [currentAccount, accounts]);

  const shortAccountId = useMemo(() => {
    if (!accountId) return '';
    return `${accountId.slice(0, 10)}...${accountId.slice(-8)}`;
  }, [accountId]);

  const handleApprove = useCallback(() => {
    if (!accountId) return;
    onResult({
      confirmed: true,
      accountPublicKey: accountId,
      privateDataPermission: request.privateDataPermission || PrivateDataPermission.UponRequest
    });
  }, [accountId, onResult, request.privateDataPermission]);

  const handleDeny = useCallback(() => {
    onResult({ confirmed: false });
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-pure-white/10 dark:bg-pure-black/50 backdrop-blur-xl backdrop-saturate-150 p-4">
      <div className="bg-surface-solid rounded-2xl w-full max-w-sm shadow-xl">
        {/* Header */}
        <div className="p-6 border-b border-grey-100">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-primary-100 flex items-center justify-center">
              <Icon name={IconName.Globe} size="lg" className="text-primary-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-grey-800 truncate">
                {request.appMeta?.name || request.origin}
              </h2>
              <p className="text-sm text-grey-500 truncate">{request.origin}</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          <p className="text-grey-600 mb-4">{t('dappConnectionRequest')}</p>

          {/* Account to connect */}
          <div className="bg-grey-50 rounded-xl p-4 mb-4">
            <p className="text-xs text-grey-500 mb-1">{t('account')}</p>
            <p className="text-sm font-mono text-grey-800">{shortAccountId || t('noAccountSelected')}</p>
          </div>

          {/* Network */}
          <div className="bg-grey-50 rounded-xl p-4">
            <p className="text-xs text-grey-500 mb-1">{t('network')}</p>
            <p className="text-sm text-grey-800 capitalize">{request.network}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="p-6 border-t border-grey-100 flex gap-3">
          <FormSecondaryButton className="flex-1" onClick={handleDeny}>
            {t('deny')}
          </FormSecondaryButton>
          <FormSubmitButton className="flex-1" type="button" onClick={handleApprove} disabled={!accountId}>
            {t('approve')}
          </FormSubmitButton>
        </div>
      </div>
    </div>
  );
};

export default DAppConnectionModal;
