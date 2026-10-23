import React, { useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AmountInput, type AmountInputProps } from 'components/AmountInput';
import { TextAction } from 'components/ui/TextAction';
import { tokenQuote } from 'lib/miden/swap/tokens';
import { tokenToUsd, usdEstimateText, usdQuoteStatus, usdToToken } from 'lib/prices/amount';
import type { TokenPriceInfo } from 'lib/prices/binance';
import { useQuoteClock } from 'lib/prices/use-quote-clock';
import { useWalletStore } from 'lib/store';

export interface TokenAmountInputProps extends Omit<AmountInputProps, 'onValueChange' | 'prefix'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Runs only for a keyboard/clear edit, not quote invalidation or recalculation. */
  onUserEdit?: () => void;
  assetId: string;
  symbol: string;
  decimals: number;
  scaleIsKnown: boolean;
  /** Omit to resolve a Miden faucet. External assets must supply an identity-verified quote. */
  quote?: TokenPriceInfo;
  externalAsset?: boolean;
  /** Explicit token-native selection such as MAX, including a same-value selection. */
  tokenIntentKey?: string | number | boolean;
}

/** Keeps the active denomination intent through asset and quote changes. */
export const TokenAmountInput: React.FC<TokenAmountInputProps> = props => <DenominatedAmountInput {...props} />;

const DenominatedAmountInput: React.FC<TokenAmountInputProps> = ({
  value,
  onValueChange,
  onUserEdit,
  assetId,
  symbol,
  decimals,
  scaleIsKnown,
  quote: suppliedQuote,
  externalAsset = false,
  tokenIntentKey,
  unfocusedDisplayValue,
  helper,
  disabled,
  loading,
  ...props
}) => {
  const { t } = useTranslation();
  const prices = useWalletStore(state => state.tokenPrices);
  const priceState = useWalletStore(state => state.tokenPricesStatus);
  const quote = externalAsset ? suppliedQuote : tokenQuote(prices, assetId, symbol);
  useQuoteClock();
  const status = scaleIsKnown ? usdQuoteStatus(quote, Date.now()) : 'unavailable';
  const ready = status === 'ready' && !!quote;
  const price = ready ? quote.price : undefined;
  const [usdMode, setUsdMode] = useState(false);
  const [usdText, setUsdText] = useState('');
  // Parent value is always exact transaction input. It never receives a formatted display value.
  const exactToken = useRef(value);
  const emitted = useRef(value);
  const enteredPrice = useRef(price);
  const enteredAsset = useRef(assetId);
  const tokenIntent = useRef(false);
  // Display provenance only: transaction values remain exact resolved base units.
  const [tokenSource, setTokenSource] = useState<'token' | 'usd'>('token');
  const previousTokenIntentKey = useRef(tokenIntentKey);
  const change = (tokens: string) => {
    emitted.current = tokens;
    onValueChange(tokens);
  };

  useEffect(() => {
    if (enteredAsset.current !== assetId) {
      enteredAsset.current = assetId;
      enteredPrice.current = price;
      if (usdMode) {
        tokenIntent.current = false;
        setTokenSource('usd');
        // The entered dollars belong to the user, while their token resolution belongs to the asset.
        const tokens = price === undefined ? '' : usdToToken(usdText, price, decimals);
        exactToken.current = tokens;
        change(tokens);
        return;
      }
    }
    const explicitTokenSelection = previousTokenIntentKey.current !== tokenIntentKey && tokenIntentKey !== false;
    previousTokenIntentKey.current = tokenIntentKey;
    if (value === emitted.current && !explicitTokenSelection) return;
    tokenIntent.current = true;
    setTokenSource('token');
    // MAX, a solver response or another parent edit is a new exact token selection.
    exactToken.current = value;
    emitted.current = value;
    enteredPrice.current = price;
    if (usdMode) setUsdText(price === undefined ? '' : tokenToUsd(value, price));
    // USD edits are handled synchronously; this effect observes parent/asset changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, price, usdMode, assetId, decimals, tokenIntentKey]);

  useEffect(() => {
    if (!usdMode || enteredPrice.current === price) return;
    enteredPrice.current = price;
    if (price === undefined) {
      // Keep the user's USD text, but invalidate submission until a trustworthy quote returns.
      if (emitted.current !== '') change('');
      return;
    }
    if (tokenIntent.current) {
      setUsdText(tokenToUsd(exactToken.current, price));
      if (emitted.current !== exactToken.current) change(exactToken.current);
      return;
    }
    setTokenSource('usd');
    const tokens = usdToToken(usdText, price, decimals);
    exactToken.current = tokens;
    if (tokens !== emitted.current) change(tokens);
    // Changes to text are handled synchronously in the input callback below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, usdMode, decimals]);

  const unavailableKey =
    status === 'stale'
      ? 'amountUsdStale'
      : priceState === 'loading'
        ? 'amountUsdLoading'
        : priceState === 'error'
          ? 'amountUsdError'
          : 'amountUsdUnavailable';
  const estimate = usdEstimateText(value, quote);
  const secondary = usdMode
    ? ready
      ? `${tokenSource === 'usd' && usdText ? '≈ ' : ''}${exactToken.current || '0'} ${symbol}`
      : t(unavailableKey)
    : estimate
      ? t('approxFiatValue', { value: estimate })
      : ready && !value
        ? t('amountUsdEstimate')
        : t(unavailableKey);

  return (
    <AmountInput
      {...props}
      errorId={props.errorId}
      preservePrecision
      unfocusedDisplayValue={usdMode ? undefined : unfocusedDisplayValue}
      value={usdMode ? usdText : value}
      prefix={usdMode ? '$' : undefined}
      decimalsLimit={usdMode ? 36 : (props.decimalsLimit ?? decimals)}
      maxLength={props.maxLength ?? 116}
      formatValueOnBlur={false}
      disabled={disabled || (usdMode && !ready)}
      loading={loading}
      aria-label={props['aria-label'] ?? t('amountInputUnit', { unit: usdMode ? 'USD' : symbol })}
      onValueChange={raw => {
        onUserEdit?.();
        const text = raw ?? '';
        if (usdMode) {
          tokenIntent.current = false;
          setTokenSource('usd');
          setUsdText(text);
          const tokens = price === undefined ? '' : usdToToken(text, price, decimals);
          exactToken.current = tokens;
          change(tokens);
        } else {
          setTokenSource('token');
          exactToken.current = text;
          change(text);
        }
      }}
      helper={helper}
      unitControl={
        symbol ? (
          <TextAction
            disabled={disabled || loading || (!usdMode && !ready)}
            aria-label={t('amountSwitchUnit', { unit: usdMode ? symbol : 'USD' })}
            aria-pressed={usdMode}
            data-testid="amount-denomination-toggle"
            className="max-w-28 gap-1"
            onClick={() => {
              if (usdMode) {
                setUsdMode(false);
                if (emitted.current !== exactToken.current) change(exactToken.current);
              } else if (price !== undefined) {
                exactToken.current = value;
                enteredPrice.current = price;
                setUsdText(value ? tokenToUsd(value, price) : '');
                setUsdMode(true);
              }
            }}
          >
            <span className="min-w-0 truncate">{usdMode ? 'USD' : symbol}</span>
            <Icon name={IconName.ArrowUpDown} fill="currentColor" size="xs" className="shrink-0 rotate-90 opacity-60" />
          </TextAction>
        ) : undefined
      }
      secondary={
        <span className="text-caption text-muted break-all" aria-live="polite">
          {secondary}
        </span>
      }
    />
  );
};
