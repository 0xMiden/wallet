import React, { FC, useMemo, useState } from 'react';

import { useTranslation } from 'react-i18next';
import { parseUnits } from 'viem';

import { Button, ButtonVariant } from 'components/Button';
import { MIDEN_USDC_DECIMALS, openEarnPosition } from 'lib/epoch';
import { useAccount } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';

type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * Earn — open an Epoch lending position by depositing Miden-held USDC. One of the
 * home-group swipe pages (Overview / Send / Receive / Swap / Earn). The deposit
 * spends the wallet's USDC as collateral (a P2IDE note to the Epoch allocator) and
 * the EVM lending leg is solver-fulfilled, so the user only types the EVM address
 * that will own the position plus the amount — no EVM wallet connection needed.
 */
const Earn: FC = () => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const { signTransaction } = useMidenContext();

  const [evmAddress, setEvmAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const evmAddressValid = EVM_ADDRESS_RE.test(evmAddress.trim());
  const amountValid = AMOUNT_RE.test(amount.trim()) && Number(amount) > 0;
  const canSubmit = useMemo(
    () => evmAddressValid && amountValid && !!publicKey && status !== 'submitting',
    [evmAddressValid, amountValid, publicKey, status]
  );

  const handleSubmit = async () => {
    if (!canSubmit || !publicKey) return;
    setStatus('submitting');
    setError(null);
    try {
      const baseUnits = parseUnits(amount.trim(), MIDEN_USDC_DECIMALS);
      await openEarnPosition({
        amount: baseUnits,
        evmAddress: evmAddress.trim(),
        senderPublicKey: publicKey,
        deps: { signTransaction, guardianProvider: zustandProvider }
      });
      setStatus('success');
    } catch (err) {
      console.error('[earn] openEarnPosition failed', err);
      setError(err instanceof Error ? err.message : t('earnDepositFailed'));
      setStatus('error');
    }
  };

  const reset = () => {
    setStatus('idle');
    setError(null);
    setAmount('');
  };

  return (
    <div className="h-full overflow-y-auto bg-app-bg px-5 py-6 flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-2xl font-bold text-text-primary-token">{t('earnTitle')}</span>
        <span className="text-sm text-text-tertiary-token">{t('earnDescription')}</span>
      </div>

      {status === 'success' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl bg-gray-50 p-4 flex flex-col gap-1">
            <span className="text-sm font-semibold text-black">{t('earnDepositSuccessTitle')}</span>
            <span className="text-xs text-text-tertiary-token">{t('earnDepositSuccess')}</span>
          </div>
          <Button variant={ButtonVariant.Primary} title={t('earnOpenAnother')} onClick={reset} className="w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-black">{t('earnEvmAddressLabel')}</span>
            <input
              value={evmAddress}
              onChange={e => setEvmAddress(e.target.value)}
              placeholder={t('earnEvmAddressPlaceholder')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full rounded-2xl bg-gray-50 px-4 py-3 text-sm text-black outline-none font-mono"
            />
            {evmAddress.trim() !== '' && !evmAddressValid && (
              <span className="text-xs text-status-negative">{t('earnInvalidEvmAddress')}</span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-black">{t('earnAmountLabel')}</span>
            <div className="flex items-center rounded-2xl bg-gray-50 px-4 py-3 gap-2">
              <input
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={t('earnAmountPlaceholder')}
                inputMode="decimal"
                className="grow bg-transparent text-sm text-black outline-none"
              />
              <span className="text-sm font-medium text-text-tertiary-token">USDC</span>
            </div>
          </label>

          {status === 'error' && error && (
            <div className="rounded-2xl bg-status-negative/10 px-4 py-3">
              <span className="text-xs text-status-negative break-words">{error}</span>
            </div>
          )}

          <Button
            variant={ButtonVariant.Primary}
            title={t('earnOpenPositionCta')}
            onClick={handleSubmit}
            disabled={!canSubmit}
            isLoading={status === 'submitting'}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
};

export default Earn;
