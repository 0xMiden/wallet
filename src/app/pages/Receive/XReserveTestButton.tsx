import React, { useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';
import type { Hash } from 'viem';

import { Button, ButtonVariant } from 'components/ui/Button';
import { CopyButton } from 'components/ui/CopyButton';
import { TextAction } from 'components/ui/TextAction';
import { isEvmAddress } from 'lib/epoch/evm-address';
import { useAccount } from 'lib/miden/front';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { openExternalUrl } from 'lib/mobile/external-browser';

export const XReserveTestButton: React.FC<{ apiUrl: string }> = ({ apiUrl }) => {
  const { t } = useTranslation();
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<Hash>();
  const [error, setError] = useState<string>();
  const submitting = useRef(false);
  const evmAddress = account.evmAddress;
  const supported = isEvmAddress(evmAddress);

  const submit = async () => {
    if (submitting.current || !isEvmAddress(evmAddress)) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    setTxHash(undefined);
    try {
      const { submitRelayTest } = await import('lib/usdcx/relay-client');
      const hash = await submitRelayTest(apiUrl, account.publicKey, accountRefToSdk(account.publicKey).toString(), evmAddress);
      setTxHash(hash);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('xreserveTestUnknownError'));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="xreserve-test">
      <p className="text-caption text-muted">{t('xreserveTestDescription')}</p>
      {supported && (
        <CopyButton
          text={evmAddress}
          label={evmAddress}
          icon="trailing"
          className="min-h-11 break-all text-action text-accent-tint-ink"
        />
      )}
      <Button
        variant={ButtonVariant.Secondary}
        disabled={!supported || busy || !!txHash}
        isLoading={busy}
        onClick={() => void submit()}
        data-testid="xreserve-test-submit"
      >
        {t('xreserveTestButton')}
      </Button>
      {!supported && <p className="text-caption text-muted">{t('xreserveTestNoEvmAddress')}</p>}
      {error && <p role="alert" className="text-caption text-negative-ink break-words">{t('xreserveTestError', { error })}</p>}
      {txHash && (
        <div role="status" className="flex flex-col gap-2">
          <p className="text-caption text-muted">{t('xreserveTestSubmitted')}</p>
          <CopyButton text={txHash} label={txHash} icon="trailing" className="min-h-11 break-all text-caption text-ink" />
          <TextAction onClick={() => void openExternalUrl({
            url: `https://sepolia.etherscan.io/tx/${txHash}`,
            title: t('xreserveTestExplorer')
          })}>
            {t('xreserveTestExplorer')}
          </TextAction>
        </div>
      )}
    </div>
  );
};
