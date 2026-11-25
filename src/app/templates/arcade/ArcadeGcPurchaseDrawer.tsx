import React from 'react';

import { useTranslation } from 'react-i18next';

import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/ui/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { formatAmountDisplay } from 'lib/i18n/amount-display';
import { getNumberSymbols } from 'lib/i18n/core';
import { GC_DECIMALS, pickGcPurchasePackageSale, quoteGcPurchasePackage, type GcSale } from 'lib/miden/arcade/gc-sale';
import type { GcPurchaseQuote } from 'lib/miden/transaction/initiate';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { USDCX_DECIMALS } from 'lib/usdcx/protocol';

export const ArcadeGcPurchaseDrawer: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale: GcSale | null;
  sales?: GcSale[];
  /** The wallet's USDCx, in base units; null while unread. */
  payBalance: bigint | null;
  submitting: boolean;
  error: string | null;
  onConfirm: (quote: GcPurchaseQuote) => void;
}> = ({ open, onOpenChange, sale: initialSale, sales, payBalance, submitting, error, onConfirm }) => {
  const { t } = useTranslation();
  const { group, decimal } = getNumberSymbols();
  const sale = sales === undefined ? initialSale : pickGcPurchasePackageSale(sales);
  const quote = sale ? quoteGcPurchasePackage(sale) : null;
  const baseFee = useVerificationBaseFee();
  const roundedBaseFee = baseFee === null ? 0 : Math.ceil(baseFee);
  // One base fee is the minimum charge. Use it to refuse only a certain shortfall.
  const feeFloor = roundedBaseFee > 0 && Number.isSafeInteger(roundedBaseFee) ? BigInt(roundedBaseFee) : 0n;
  const insufficient = quote !== null && payBalance !== null && payBalance < quote.fillAmount + feeFloor;
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="arcade-gc-purchase">
      <DrawerContent data-testid="arcade-gc-purchase-review">
        <DrawerHeader>
          <DrawerTitle>{t('arcadeBuyMoreGc')}</DrawerTitle>
        </DrawerHeader>
        <DrawerDescription>{t('arcadeGcPurchaseReviewBody')}</DrawerDescription>
        <div className="flex flex-col gap-3 px-4 pb-4">
          {quote ? (
            <DetailCard>
              <DetailRow label={t('arcadeGcPurchaseYouPay')}>
                {t('arcadeGcPurchaseUsdcx', {
                  amount: formatAmountDisplay(quote.fillAmount, { decimals: USDCX_DECIMALS, formatting: 'exact' })
                })}
              </DetailRow>
              <DetailRow label={t('arcadeGcPurchaseYouReceive')}>
                {t('arcadeBalance', {
                  balance: formatAmountDisplay(quote.expectedAmount, {
                    decimals: GC_DECIMALS,
                    formatting: 'exact',
                    grouping: true,
                    separators: { group, decimal }
                  })
                })}
              </DetailRow>
              <DetailRow label={t('networkFee')}>{t('arcadeGcPurchaseFeeSeparate')}</DetailRow>
            </DetailCard>
          ) : (
            <Notice variant="inline" tone="warning">
              {t('arcadeGcPurchaseUnavailable')}
            </Notice>
          )}
          {insufficient && (
            <Notice variant="inline" tone="warning" data-testid="arcade-gc-purchase-insufficient">
              {t('arcadeGcPurchaseInsufficient')}
            </Notice>
          )}
          {error && (
            <Notice
              variant="inline"
              tone="negative"
              errorId="raw_arcade_gc_purchase_failed"
              data-testid="arcade-gc-purchase-error"
            >
              {error}
            </Notice>
          )}
          {quote && (
            <Notice variant="inline" icon={<Icon name={IconName.ShieldCheck} size="sm" fill="currentColor" />}>
              {t('arcadePostingPolicy')}
            </Notice>
          )}
        </div>
        <DrawerFooter>
          <Button
            disabled={quote === null || insufficient || submitting}
            isLoading={submitting}
            onClick={() => {
              if (quote) onConfirm(quote);
            }}
            data-testid="arcade-gc-purchase-confirm"
          >
            {t('arcadeGcPurchaseConfirm')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};
