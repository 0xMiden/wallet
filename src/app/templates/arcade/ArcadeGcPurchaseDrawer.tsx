import React, { useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button } from 'components/ui/Button';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { TextField } from 'components/ui/TextField';
import { amountExceedsTokenDecimals, stringToBigInt } from 'lib/i18n/numbers';
import { GC_DECIMALS, quoteGcPurchase, type GcSale } from 'lib/miden/arcade/gc-sale';
import type { GcPurchaseQuote } from 'lib/miden/transaction/initiate';
import { formatAmount } from 'lib/shared/format';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { USDCX_DECIMALS } from 'lib/usdcx/protocol';

/** What the sheet opens at. */
const DEFAULT_GC_AMOUNT_TEXT = '1';

type AmountReading =
  | { quote: GcPurchaseQuote }
  | {
      errorId:
        | 'invalidAmount'
        | 'amountExceedsTokenDecimals'
        | 'arcadeGcPurchaseAboveInventory'
        | 'arcadeGcPurchaseBelowMinimum';
    };

/** The quote for the typed GC amount, or the error the field shows. */
function readAmount(sale: GcSale, text: string): AmountReading {
  if (amountExceedsTokenDecimals(text, GC_DECIMALS)) return { errorId: 'amountExceedsTokenDecimals' };
  let gcAmount: bigint;
  try {
    gcAmount = stringToBigInt(text, GC_DECIMALS);
  } catch {
    return { errorId: 'invalidAmount' };
  }
  const result = quoteGcPurchase(sale, gcAmount);
  if ('quote' in result) return result;
  switch (result.refusal) {
    case 'zero':
      return { errorId: 'invalidAmount' };
    case 'above_inventory':
      return { errorId: 'arcadeGcPurchaseAboveInventory' };
    case 'below_fill_floor':
      return { errorId: 'arcadeGcPurchaseBelowMinimum' };
  }
}

/**
 * The review of a GC purchase: how many GC to buy (1 by default), what that costs at the live note's price, that
 * network fees come on top, and whether the wallet holds the USDCx to pay it. Confirm hands the quote back; the
 * caller queues the row and navigates.
 */
export const ArcadeGcPurchaseDrawer: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sale: GcSale | null;
  /** The wallet's USDCx, in base units; null while unread. */
  payBalance: bigint | null;
  submitting: boolean;
  error: string | null;
  onConfirm: (quote: GcPurchaseQuote) => void;
}> = ({ open, onOpenChange, sale, payBalance, submitting, error, onConfirm }) => {
  const { t } = useTranslation();
  const [amountText, setAmountText] = useState(DEFAULT_GC_AMOUNT_TEXT);
  // Each opening starts over at the default, so a closed sheet never keeps a stale amount.
  useEffect(() => {
    if (open) setAmountText(DEFAULT_GC_AMOUNT_TEXT);
  }, [open]);
  const reading = sale ? readAmount(sale, amountText) : null;
  const quote = reading && 'quote' in reading ? reading.quote : null;
  const amountErrorId: UserErrorId | null = reading && 'errorId' in reading ? reading.errorId : null;
  const amountError = (() => {
    switch (amountErrorId) {
      case null:
        return undefined;
      case 'arcadeGcPurchaseAboveInventory':
        return t(amountErrorId, { available: formatAmount(sale?.offeredAmount ?? 0n, GC_DECIMALS) });
      default:
        return t(amountErrorId);
    }
  })();
  const insufficient = quote !== null && payBalance !== null && payBalance < quote.fillAmount;
  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="arcade-gc-purchase">
      <DrawerContent data-testid="arcade-gc-purchase-review">
        <DrawerHeader>
          <DrawerTitle>{t('arcadeBuyMoreGc')}</DrawerTitle>
        </DrawerHeader>
        <DrawerDescription>{t('arcadeGcPurchaseReviewBody')}</DrawerDescription>
        {sale && (
          <div className="flex flex-col gap-3 px-4 pb-4">
            <TextField
              label={t('arcadeGcPurchaseAmountLabel')}
              value={amountText}
              onChange={event => setAmountText(event.target.value)}
              inputMode="decimal"
              autoComplete="off"
              error={amountError}
              errorId={amountErrorId}
              hint={t('arcadeGcPurchasePrice', {
                price: formatAmount(
                  (sale.requestedAmount * 10n ** BigInt(GC_DECIMALS) + sale.offeredAmount - 1n) / sale.offeredAmount,
                  USDCX_DECIMALS
                )
              })}
              data-testid="arcade-gc-purchase-amount"
            />
            <DetailCard>
              <DetailRow label={t('arcadeGcPurchaseYouPay')}>
                {quote
                  ? t('arcadeGcPurchaseUsdcx', { amount: formatAmount(quote.fillAmount, USDCX_DECIMALS) })
                  : t('arcadeGcPurchaseNoQuote')}
              </DetailRow>
              <DetailRow label={t('arcadeGcPurchaseYouReceive')}>
                {quote
                  ? t('arcadeBalance', { balance: formatAmount(quote.expectedAmount, GC_DECIMALS) })
                  : t('arcadeGcPurchaseNoQuote')}
              </DetailRow>
              <DetailRow label={t('networkFee')}>{t('arcadeGcPurchaseFeeSeparate')}</DetailRow>
            </DetailCard>
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
            <Notice variant="inline" icon={<Icon name={IconName.ShieldCheck} size="sm" fill="currentColor" />}>
              {t('arcadePostingPolicy')}
            </Notice>
          </div>
        )}
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
