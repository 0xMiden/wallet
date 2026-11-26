import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { normalizeDecimalInput, normalizeLeadingZeroes } from 'components/AmountInput';
import { NetworkLogo } from 'components/NetworkChip';
import { TokenLogo } from 'components/TokenLogo';
import { Button } from 'components/ui/Button';
import { formatUsdDisplay } from 'lib/i18n/amount-display';
import { hapticLight } from 'lib/mobile/haptics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { cn } from 'lib/ui/util';

import { DepositAmount, depositAmountText, DepositFeeValue, DepositNotice, useUsdEstimateText } from './parts';
import * as s from './styles';
import type {
  DepositAmountValue,
  DepositFee,
  DepositLayout,
  DepositNetworkDisplay,
  DepositTokenDisplay
} from './types';

/** A total longer than this many characters drops from 26px to 20px, as the mock-up's `quote()` does. */
const LONG_TOTAL_CHARS = 8;

/** The id that reports the cap notice on screen, or null when no cap notice shows. */
function capErrorIdOf(capUsd: number | undefined, unpriced: string | undefined): UserErrorId | null {
  if (capUsd !== undefined) return 'bridgeDepositBalanceCapExceeded';
  if (unpriced !== undefined) return 'bridgeDepositBalanceCapUnpriced';
  return null;
}

export interface DepositAmountViewProps {
  /** `extension` takes the popup's tighter sizes (`.phone.ext`). Defaults to `mobile`. */
  layout?: DepositLayout;
  /** The typed amount: exact decimal text in source-token units, or '' when empty. */
  amount: string;
  onAmountChange: (value: string) => void;
  /** The source token's decimals: the field takes no more fraction digits than these. */
  decimals: number;
  /** The typed amount in USD. Omit while there is no price: the line under the amount stays empty. */
  amountUsd?: number;
  /** The token the user sends, on `network`. */
  sourceToken: DepositTokenDisplay;
  /** The token that arrives in the wallet. */
  receivedToken: DepositTokenDisplay;
  network: DepositNetworkDisplay;
  /** Opens the caller's token-and-network sheet. */
  onSelectToken: () => void;
  bridgeFee: DepositFee;
  /**
   * True (the default) when the route takes its fee out of the amount: the fee reads "− 0.21 USDC". False when the
   * fee comes on top of the amount (a quote for an exact received amount): the fee has no minus sign.
   */
  bridgeFeeDeducted?: boolean;
  /** The chosen route's name (Agglayer, Epoch). */
  routeName: string;
  /** How many routes can take this pair: "Change" shows only when there is more than one. */
  routeCount: number;
  /** Opens the route sheet. */
  onChangeRoute: () => void;
  /** The route's arrival time, already translated. Omit to leave the row out. */
  arrivesIn?: string;
  /**
   * Who pays the network gas, already translated (the mock-up's `fees().gas`). Defaults to "Paid by Bread", the relay
   * routes' value.
   */
  networkGas?: string;
  /** What arrives, in `receivedToken` units. Omit while there is no quote: the total reads 0.00. */
  received?: DepositAmountValue;
  /** `received` in USD. */
  receivedUsd?: number;
  /** The deposit would take the wallet over its cap: the cap notice shows with the cap in USD. */
  depositCapUsd?: number;
  /**
   * The cap cannot be checked because the token has no price: this text shows in a negative notice. Ignored while
   * `depositCapUsd` is set.
   */
  depositCapUnpriced?: string;
  /** A field under the receipt card, above the notices: the refund address of a NEAR Intents deposit. */
  field?: React.ReactNode;
  /** Another notice under the cap notice, such as a test-funds warning. */
  notice?: React.ReactNode;
  /** The amount can be reviewed. "Review" stays disabled while false. */
  isValidAmount: boolean;
  onReview: () => void;
}

/**
 * The deposit amount screen (mock-up `viewAmount`): one large amount, the token-and-network
 * button, the receipt card that ends on a ruled "You receive" total, the deposit cap notice and the
 * pinned "Review" button. The caller draws the page header above it.
 */
export const DepositAmountView: React.FC<DepositAmountViewProps> = ({
  layout = 'mobile',
  amount,
  onAmountChange,
  decimals,
  amountUsd,
  sourceToken,
  receivedToken,
  network,
  onSelectToken,
  bridgeFee,
  bridgeFeeDeducted = true,
  routeName,
  routeCount,
  onChangeRoute,
  arrivesIn,
  networkGas,
  received,
  receivedUsd,
  depositCapUsd,
  depositCapUnpriced,
  field,
  notice,
  isValidAmount,
  onReview
}) => {
  const { t } = useTranslation();
  // The cap notices are the deposit screen's cap errors: they have the same ids there.
  useUserVisibleError(capErrorIdOf(depositCapUsd, depositCapUnpriced), 'notice');
  const ext = layout === 'extension';
  const amountUsdText = useUsdEstimateText(amountUsd);
  const receivedUsdText = useUsdEstimateText(received ? receivedUsd : undefined);
  const totalText = received ? depositAmountText(received, 'down') : '0.00';
  const row = cn(s.RC3_ROW, ext && s.RC3_ROW_EXT);

  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const normalized = normalizeLeadingZeroes(normalizeDecimalInput(event.target.value));
    if (!/^\d*(?:\.\d*)?$/.test(normalized)) return;
    const fraction = normalized.split('.')[1] ?? '';
    if (fraction.length > decimals) return;
    onAmountChange(normalized);
  };

  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <Button
          title={t('review')}
          accent="send"
          onClick={onReview}
          disabled={!isValidAmount}
          className="w-full max-w-none disabled:bg-accent-send disabled:opacity-40"
          data-testid="deposit-amount-review"
        />
      }
    >
      <div className={cn(s.BASE, 'flex flex-col', s.TOP_AFTER_HEADER.amount[layout])}>
        <span className={s.LAB3}>{t('depositFlowDepositAmount')}</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="0.00"
          aria-label={t('amount')}
          value={amount}
          onChange={onChange}
          className={cn(s.N3, ext && s.N3_EXT)}
          data-testid="deposit-amount-input"
        />
        <span className={cn(s.EST3, ext && s.EST3_EXT)} aria-live="polite" data-testid="deposit-amount-usd">
          {amountUsdText}
        </span>
        <button
          type="button"
          onClick={() => {
            hapticLight();
            onSelectToken();
          }}
          aria-haspopup="dialog"
          aria-label={t('depositFlowTokenOnNetworkChange', { token: sourceToken.symbol, network: network.name })}
          className={s.TK4}
          data-testid="deposit-token-selector"
        >
          <span className={s.TK4_SEG}>
            <TokenLogo faucetId={sourceToken.logoFaucetId} size="md" className={s.LOGO_28} />
            {sourceToken.symbol}
          </span>
          <span className={s.TK4_SEG_NEXT}>
            <span className="flex size-7 items-center justify-center [&>*]:!size-7" data-testid="deposit-network-logo">
              <NetworkLogo kind="ethereum" network={network.id} size="md" />
            </span>
            <Icon name={IconName.ChevronDown} fill="currentColor" aria-hidden="true" className={s.ICON_14} />
          </span>
        </button>

        <div className={cn(s.RC3, ext && s.RC3_EXT)} data-testid="deposit-receipt">
          <div className={row} data-testid="deposit-receipt-fee">
            <span className={s.ROW_LABEL}>{t('depositFlowBridgeFee')}</span>
            <b className={s.RC3_VALUE}>
              <DepositFeeValue fee={bridgeFee} symbol={sourceToken.symbol} minusSign={bridgeFeeDeducted} />
            </b>
          </div>
          <div className={cn(row, s.RULE_TOP)} data-testid="deposit-receipt-route">
            <span className={s.ROW_LABEL}>{t('route')}</span>
            <b className={s.RC3_VALUE}>
              {routeName}
              {routeCount > 1 && (
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => {
                    hapticLight();
                    onChangeRoute();
                  }}
                  className={s.CHG}
                  data-testid="deposit-route-change"
                >
                  {t('depositFlowChange')}
                  <Icon name={IconName.ChevronDown} fill="currentColor" aria-hidden="true" className={s.ICON_12} />
                </button>
              )}
            </b>
          </div>
          {arrivesIn !== undefined && (
            <div className={cn(row, s.RULE_TOP)} data-testid="deposit-receipt-arrival">
              <span className={s.ROW_LABEL}>{t('depositFlowArrivesIn')}</span>
              <b className={s.RC3_VALUE}>{arrivesIn}</b>
            </div>
          )}
          <div className={cn(row, s.RULE_TOP)} data-testid="deposit-receipt-gas">
            <span className={s.ROW_LABEL}>{t('depositFlowNetworkGas')}</span>
            <b className={s.RC3_VALUE}>{networkGas ?? t('depositFlowPaidByBread')}</b>
          </div>
          <div className={cn(s.TOT, ext && s.TOT_EXT)} data-testid="deposit-receipt-total">
            <span className={s.TOT_LABEL}>{t('depositFlowYouReceive')}</span>
            <b className={s.TOT_VALUE}>
              <span
                className={cn(totalText.length > LONG_TOTAL_CHARS && s.TOT_VALUE_LONG)}
                data-testid="deposit-receipt-total-amount"
              >
                {received ? (
                  <DepositAmount value={received} symbol={receivedToken.symbol} rounding="down" />
                ) : (
                  `${totalText} ${receivedToken.symbol}`
                )}
              </span>
              <small className={s.TOT_SMALL}>{receivedUsdText}</small>
            </b>
          </div>
        </div>

        <div className={cn(s.BODY_STACK, 'pt-4')}>
          {field}
          {depositCapUsd !== undefined && (
            <DepositNotice
              kind="negative"
              role="alert"
              title={t('depositFlowOverCapTitle')}
              data-testid="deposit-cap-notice"
            >
              {t('depositFlowOverCapBody', { cap: formatUsdDisplay(depositCapUsd, { minimumFractionDigits: 0 }) })}
            </DepositNotice>
          )}
          {depositCapUsd === undefined && depositCapUnpriced !== undefined && (
            <DepositNotice kind="negative" role="alert" data-testid="deposit-cap-unpriced">
              {depositCapUnpriced}
            </DepositNotice>
          )}
          {notice}
        </div>
      </div>
    </HomeGroupPaneBody>
  );
};
