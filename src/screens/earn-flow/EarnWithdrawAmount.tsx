import React, { useState } from 'react';

import { useTranslation } from 'react-i18next';

import { formatMoneyAmount } from 'app/templates/history/transactionUtils';
import { Button, ButtonVariant } from 'components/Button';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { TokenAmountInput } from 'components/TokenAmountInput';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { withdrawalAmountError } from 'lib/epoch/withdraw-amount';
import { evmQuote } from 'lib/prices/evm';
import { useWalletStore } from 'lib/store';
import { isUserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { goBack, navigate } from 'lib/woozie';

import { EarnAmountUnit, EarnAssetMark, EarnSubjectSubtitle, earnSubjectTitle } from './components';
import { EarnLoadError } from './EarnLoadError';
import { earnItemLoadState, useEarnPositions } from './useEarnPositions';

const EarnWithdrawAmount: React.FC<{ positionId: string }> = ({ positionId }) => {
  const { t } = useTranslation();
  const prices = useWalletStore(state => state.tokenPrices);
  const [amount, setAmount] = useState('');
  const [fullBalanceSelected, setFullBalanceSelected] = useState(false);
  const { positions, isLoading, error, errorDiagnostics, refetch } = useEarnPositions();
  const position = positions.find(item => item.id === positionId);
  const { pending } = earnItemLoadState(position, { isLoading, error });
  const validation = position ? withdrawalAmountError(amount, position.withdrawable, position.decimals) : undefined;
  const canReview = Boolean(position && !position.stale && !validation);
  return (
    <div className="flex h-full flex-col overflow-hidden bg-page">
      <NetworkModeBanner />
      <SubPageLayout
        data-testid="earn-withdraw-amount-page"
        title={position ? earnSubjectTitle(position) : t('withdraw')}
        subtitle={position && <EarnSubjectSubtitle subject={position} />}
        headerActions={position && <EarnAssetMark asset={position.asset} network={position.network} decorative />}
        onBack={goBack}
        footer={
          position && (
            <Button
              title={t('review')}
              accent="earn"
              className="w-full max-w-none"
              disabled={!canReview}
              onClick={() => {
                if (canReview)
                  navigate(
                    `/earn/positions/${encodeURIComponent(positionId)}/withdraw/review?amount=${encodeURIComponent(amount)}`
                  );
              }}
            />
          )
        }
      >
        {!position && !pending ? (
          <EarnLoadError errorDiagnostics={errorDiagnostics} onRetry={refetch} />
        ) : (
          position && (
            <>
              {error && <EarnLoadError errorDiagnostics={errorDiagnostics} onRetry={refetch} />}
              <TokenAmountInput
                assetId={`${position.chainId}:${position.underlyingAddress}`}
                symbol={position.asset}
                decimals={position.decimals}
                scaleIsKnown
                externalAsset
                quote={evmQuote(prices, Number(position.chainId), position.underlyingAddress)}
                value={amount}
                tokenIntentKey={fullBalanceSelected}
                onUserEdit={() => setFullBalanceSelected(false)}
                onValueChange={value => setAmount(value ?? '')}
                label={<span className="text-row-title text-muted">{t('earnWithdrawAmount')}</span>}
                aria-label={t('earnWithdrawAmount')}
                accent="earn"
                showDivider={false}
                decimalsLimit={36}
                maxLength={116}
                allowNegativeValue
                formatValueOnBlur={false}
                errorId={validation && isUserErrorId(validation) ? validation : null}
                error={amount && validation ? t(validation, { decimals: position.decimals }) : undefined}
                tokenSelector={
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <EarnAmountUnit symbol={position.asset} />
                    <Button
                      title={t('max')}
                      size="sm"
                      variant={fullBalanceSelected ? ButtonVariant.Secondary : ButtonVariant.Ghost}
                      accent="earn"
                      disabled={position.stale}
                      onClick={() => {
                        // Snapshot exact units. The compact display must never become the submitted amount.
                        setAmount(position.withdrawable);
                        setFullBalanceSelected(true);
                      }}
                    />
                  </div>
                }
                helper={
                  <div className="flex flex-col gap-1 text-caption text-muted face-heading">
                    {fullBalanceSelected && (
                      <span className="text-accent-earn-ink">{t('earnWithdrawFullBalanceSelected')}</span>
                    )}
                    <span>
                      {t('earnWithdrawAvailable', {
                        amount: formatMoneyAmount(position.withdrawable, 'receives', position.asset),
                        asset: position.asset
                      })}
                    </span>
                  </div>
                }
              />
            </>
          )
        )}
      </SubPageLayout>
    </div>
  );
};
export default EarnWithdrawAmount;
