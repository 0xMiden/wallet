import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Clipboard } from '@capacitor/clipboard';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { usePageActive } from 'app/layouts/page-active';
import { AmountInput } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { NetworkLogo } from 'components/NetworkChip';
import { TokenLogo } from 'components/TokenLogo';
import { Card } from 'components/ui/Card';
import { ErrorLine } from 'components/ui/ErrorLine';
import { IconCircle } from 'components/ui/FactRow';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { TextField } from 'components/ui/TextField';
import { amountExceedsTokenDecimals, stringToBigInt } from 'lib/i18n/numbers';
import { useAccount } from 'lib/miden/front';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { isValidNearIntentsAddress } from 'lib/one-click/address';
import { requestOneClickQuote } from 'lib/one-click/client';
import { persistNearIntentsDeposit } from 'lib/one-click/tracking';
import type {
  NearIntentsCatalog,
  NearIntentsConfig,
  OneClickQuoteRequest,
  OneClickQuoteResponse
} from 'lib/one-click/types';
import { isMobile } from 'lib/platform';
import { navigate } from 'lib/woozie';

import { chainLogoNetwork, NearIntentsSelection, resolveSelection, tokenLogoSymbol } from './chains';
import { arrivalMinutes, formatQuoteUsd, formatRate } from './format';
import { isPreviewRefundAddress, previewRefundAddress } from './preview-refund';
import { ReceiveTokenDrawer } from './ReceiveTokenDrawer';
import { SendTokenDrawer } from './SendTokenDrawer';
import { nearIntentsQuoteExpired, useNearIntentsQuote } from './useNearIntentsQuote';

/** The life of a quote request: the deadline that the wallet asks 1Click for. */
export const QUOTE_LIFETIME_MS = 5 * 60_000;
/** The preview deadline moves forward at this interval, before the 5 minutes run out. */
const PREVIEW_DEADLINE_REFRESH_MS = 240_000;
/** Each quote allows 1% of slippage, in basis points, as the swap route did. */
const SLIPPAGE_BPS = 100;

const deadlineFromNow = (): string => new Date(Date.now() + QUOTE_LIFETIME_MS).toISOString();

/** True when 1Click refused the quote because it has no liquidity for the amount (`OneClickHttpError.code`). */
const isNoLiquidityError = (error: Error | undefined): boolean =>
  error !== undefined && 'code' in error && error.code === 'no_liquidity';

/** The parts of a request that make the route, without the deadline that moves on each refresh. */
const routeKey = (request: OneClickQuoteRequest): string =>
  JSON.stringify([
    request.amount,
    request.originAsset.assetId,
    request.destinationAsset.assetId,
    request.refundTo,
    request.recipient
  ]);

export interface NearIntentsFormProps {
  config: NearIntentsConfig;
  catalog: NearIntentsCatalog;
  /** The Receive tabs, drawn as the first line of the body. */
  tabs?: React.ReactNode;
}

/**
 * The NEAR Intents receive form: the origin chain and token, the amount, the Miden token, and the
 * refund address. It shows a dry quote while the inputs are valid. "Get deposit address" asks for
 * the real quote, saves the tracking row, and opens the deposit page of that row.
 */
export const NearIntentsForm: React.FC<NearIntentsFormProps> = ({ config, catalog, tabs }) => {
  const { t } = useTranslation();
  const { publicKey } = useAccount();
  const pageActive = usePageActive();

  const [selection, setSelection] = useState<NearIntentsSelection>({});
  const [amount, setAmount] = useState('');
  const [refundAddress, setRefundAddress] = useState('');
  const [sendDrawerOpen, setSendDrawerOpen] = useState(false);
  const [receiveDrawerOpen, setReceiveDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [previewDeadline, setPreviewDeadline] = useState(deadlineFromNow);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const resolved = resolveSelection(catalog, selection);
  const chain = resolved?.chain;
  const token = resolved?.token;
  const output = resolved?.output;

  const selectToken = useCallback(
    (chainId: string, tokenAssetId: string) => {
      const nextChain = catalog.chains.find(entry => entry.id === chainId);
      // A refund address of one address kind is never valid on a chain of another kind.
      if (nextChain && chain && nextChain.addressKind !== chain.addressKind) setRefundAddress('');
      // A new token selects its first output.
      setSelection({ chainId, tokenAssetId, outputAssetId: undefined });
      setSubmitFailed(false);
    },
    [catalog, chain]
  );

  const selectOutput = useCallback((outputAssetId: string) => {
    setSelection(previous => ({ ...previous, outputAssetId }));
    setSubmitFailed(false);
  }, []);

  const trimmedRefund = refundAddress.trim();
  const refundValid =
    chain !== undefined && trimmedRefund !== '' && isValidNearIntentsAddress(chain.addressKind, trimmedRefund);
  // A user who types a preview placeholder as the refund address is refused: the guard in `submit` cannot tell
  // that address from the placeholder.
  const refundUsable = refundValid && !isPreviewRefundAddress(trimmedRefund);
  const refundError = chain !== undefined && trimmedRefund !== '' && !refundUsable;

  const amountBaseUnits = useMemo(() => {
    if (!token || amount.trim() === '' || amountExceedsTokenDecimals(amount, token.asset.decimals)) return undefined;
    try {
      const units = stringToBigInt(amount, token.asset.decimals);
      return units > 0n ? units : undefined;
    } catch {
      return undefined;
    }
  }, [amount, token]);

  const active = pageActive && !submitting;

  // The preview deadline must stay the same between renders, or every render would be a new
  // request. It moves forward before the 5 minutes run out.
  useEffect(() => {
    if (!active) return;
    setPreviewDeadline(deadlineFromNow());
    const interval = window.setInterval(() => setPreviewDeadline(deadlineFromNow()), PREVIEW_DEADLINE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [active]);

  const previewRequest = useMemo<OneClickQuoteRequest | undefined>(() => {
    if (!chain || !token || !output || amountBaseUnits === undefined || !publicKey) return undefined;
    return {
      amount: amountBaseUnits.toString(),
      originAsset: token.asset,
      destinationAsset: output,
      // The quote shows from the amount alone. Until the refund address is valid, the dry quote uses a placeholder.
      refundTo: refundUsable ? trimmedRefund : previewRefundAddress(chain.addressKind),
      recipient: publicKey,
      deadline: previewDeadline,
      slippageTolerance: SLIPPAGE_BPS
    };
  }, [chain, token, output, amountBaseUnits, refundUsable, trimmedRefund, publicKey, previewDeadline]);
  const previewRequestRef = useRef(previewRequest);
  previewRequestRef.current = previewRequest;

  const queryPreview = useCallback(
    (request: OneClickQuoteRequest) => requestOneClickQuote(config, request, true),
    [config]
  );
  const preview = useNearIntentsQuote(previewRequest, queryPreview, active);
  const quote: OneClickQuoteResponse | undefined = previewRequest ? preview.quote : undefined;

  const canSubmit =
    previewRequest !== undefined &&
    refundUsable &&
    quote !== undefined &&
    !nearIntentsQuoteExpired(quote) &&
    !submitting;

  const submit = useCallback(async () => {
    const current = previewRequestRef.current;
    if (!current || !token || !output || !publicKey || submittingRef.current) return;
    // A deposit quote must carry the refund address of the user, never a preview placeholder.
    if (isPreviewRefundAddress(current.refundTo)) return;
    const faucetId = output.faucetId;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitFailed(false);
    const request: OneClickQuoteRequest = { ...current, deadline: deadlineFromNow() };
    try {
      if (!faucetId) throw new Error('The Miden output token has no faucet id');
      const depositQuote = await requestOneClickQuote(config, request, false);
      // The user changed the route while the quote was on its way: do not save a row for the old one.
      const latest = previewRequestRef.current;
      if (!latest || routeKey(latest) !== routeKey(request)) return;
      const rowId = await persistNearIntentsDeposit({
        request,
        quote: depositQuote,
        config,
        network: getEffectiveNetworkName(),
        accountId: publicKey,
        accountAddress: publicKey,
        originAsset: token.asset,
        destinationAsset: output,
        faucetId
      });
      navigate(`/receive/near-intents/${encodeURIComponent(rowId)}`);
    } catch (error) {
      console.warn('[NearIntents] the deposit address request failed', error);
      if (mountedRef.current) setSubmitFailed(true);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [config, token, output, publicKey]);

  // Paste reads the native clipboard on mobile only, as the send flow does: in a WebView the
  // web clipboard read shows the platform callout, and the extension has no clipboard read
  // permission. Off mobile the platform's own paste works in the field.
  const onPaste = useCallback(async () => {
    try {
      const { value, type } = await Clipboard.read();
      const text = type?.startsWith('text') ? value.trim() : '';
      if (text) {
        setRefundAddress(text);
        setSubmitFailed(false);
      }
    } catch {
      // An empty clipboard or a refused system prompt keeps the field as it is.
    }
  }, []);

  if (!chain || !token || !output) return null;

  const chainName = chain.name;
  const originBadge = <NetworkLogo kind="ethereum" network={chainLogoNetwork(chain.id)} />;
  const inUsd = formatQuoteUsd(quote?.quote.amountInUsd);
  const outUsd = formatQuoteUsd(quote?.quote.amountOutUsd);
  const rate = quote ? formatRate(quote.quote.amountInFormatted, quote.quote.amountOutFormatted) : undefined;

  return (
    <>
      <HomeGroupPaneBody
        testId="near-intents-form"
        top="visual"
        footer={
          <div className="flex flex-col gap-2">
            <Button
              title={t('nearIntentsGetDepositAddress')}
              variant={ButtonVariant.Primary}
              accent="receive"
              onClick={() => submit()}
              disabled={!canSubmit}
              isLoading={submitting}
              className="w-full max-w-none"
              data-testid="near-intents-get-deposit-address"
            />
            <p className="text-center text-caption text-muted">{t('nearIntentsSendFromAnyWallet')}</p>
          </div>
        }
      >
        {tabs}
        <div className="flex flex-col gap-5 pt-4">
          <div className="flex flex-col">
            <Card surface="fill" padding="row" data-testid="near-intents-send-card">
              <span className="text-label text-muted">{t('nearIntentsYouSend')}</span>
              <div className="flex items-center gap-3">
                <TokenLogo symbol={tokenLogoSymbol(token.symbol)} size="lg" badge={originBadge} />
                <AmountInput
                  className="min-w-0 flex-1"
                  size="compact"
                  value={amount}
                  onValueChange={value => {
                    setAmount(value ?? '');
                    setSubmitFailed(false);
                  }}
                  preservePrecision
                  decimalsLimit={token.asset.decimals}
                  placeholder="0"
                  showDivider={false}
                  accent="receive"
                  unitControl={
                    <Pill
                      tone="page"
                      onClick={() => setSendDrawerOpen(true)}
                      trailingIcon={
                        <Icon
                          name={IconName.ChevronDown}
                          size="xs"
                          className="text-accent-receive-ink"
                          fill="currentColor"
                        />
                      }
                      aria-haspopup="dialog"
                      aria-label={t('nearIntentsChooseSendToken', { symbol: token.symbol })}
                      data-testid="near-intents-send-token-pill"
                    >
                      {token.symbol}
                    </Pill>
                  }
                  aria-label={t('nearIntentsYouSend')}
                  data-testid="near-intents-amount"
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-caption text-muted">
                <span data-testid="near-intents-send-usd">{inUsd ?? ''}</span>
                <span className="truncate">{t('nearIntentsOnChain', { chain: chainName })}</span>
              </div>
            </Card>
            {/* The arrow between the two cards: it overlaps both, so it says that one becomes the other. */}
            <div aria-hidden="true" className="relative z-10 -my-3 flex justify-center">
              <IconCircle size="md" className="border border-hairline bg-page text-ink">
                <Icon name={IconName.ArrowDown} size="xs" fill="currentColor" />
              </IconCircle>
            </div>
            <Card surface="fill" padding="row" data-testid="near-intents-receive-card">
              <span className="text-label text-muted">{t('nearIntentsYouReceive')}</span>
              <div className="flex items-center gap-3">
                <TokenLogo
                  symbol={tokenLogoSymbol(output.symbol)}
                  faucetId={output.faucetId}
                  size="lg"
                  badge={<NetworkLogo kind="miden" />}
                />
                <AmountInput
                  className="min-w-0 flex-1"
                  size="compact"
                  value={quote?.quote.amountOutFormatted ?? ''}
                  onValueChange={() => undefined}
                  preservePrecision
                  decimalsLimit={output.decimals}
                  placeholder="0"
                  disabled
                  loading={previewRequest !== undefined && preview.loading && quote === undefined}
                  skeletonTone="onFill"
                  showDivider={false}
                  accent="receive"
                  unitControl={
                    <Pill
                      tone="page"
                      onClick={() => setReceiveDrawerOpen(true)}
                      trailingIcon={
                        <Icon
                          name={IconName.ChevronDown}
                          size="xs"
                          className="text-accent-receive-ink"
                          fill="currentColor"
                        />
                      }
                      aria-haspopup="dialog"
                      aria-label={t('nearIntentsChooseReceiveToken', { symbol: output.symbol })}
                      data-testid="near-intents-receive-token-pill"
                    >
                      {output.symbol}
                    </Pill>
                  }
                  aria-label={t('nearIntentsYouReceive')}
                  data-testid="near-intents-quoted-amount"
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-caption text-muted">
                <span data-testid="near-intents-receive-usd">{outUsd ?? ''}</span>
                <span className="truncate">{t('nearIntentsOnChain', { chain: t('miden') })}</span>
              </div>
            </Card>
          </div>

          <TextField
            label={t('nearIntentsRefundAddress')}
            labelSize="md"
            value={refundAddress}
            onChange={event => {
              setRefundAddress(event.target.value);
              setSubmitFailed(false);
            }}
            placeholder={t('nearIntentsRefundPlaceholder', { chain: chainName })}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            hint={t('nearIntentsRefundHint', { symbol: token.symbol })}
            error={refundError ? t('nearIntentsRefundInvalid', { chain: chainName }) : undefined}
            errorId={refundError ? 'invalidAddress' : null}
            errorTestId="near-intents-refund-error"
            trailing={
              isMobile() && trimmedRefund === '' ? (
                <Pill
                  tone="page"
                  icon={<Icon name={IconName.FileCopy} size="xs" fill="currentColor" />}
                  onClick={() => onPaste()}
                  data-testid="near-intents-refund-paste"
                >
                  {t('paste')}
                </Pill>
              ) : undefined
            }
            data-testid="near-intents-refund-address"
          />

          {quote && (
            <div
              className="flex items-center justify-between gap-3 text-body-sm text-muted"
              data-testid="near-intents-quote-summary"
            >
              <span className="truncate" data-testid="near-intents-rate">
                {rate !== undefined ? t('nearIntentsRate', { from: token.symbol, rate, to: output.symbol }) : ''}
              </span>
              <span className="shrink-0" data-testid="near-intents-time-estimate">
                {t('nearIntentsTimeEstimate', { minutes: String(arrivalMinutes(quote.quote.timeEstimate)) })}
              </span>
            </div>
          )}

          {previewRequest !== undefined && preview.error !== undefined && !preview.loading && (
            <ErrorLine errorId="oneClickQuoteUnavailable" data-testid="near-intents-quote-error">
              {isNoLiquidityError(preview.error) ? t('nearIntentsNoLiquidity') : t('oneClickQuoteUnavailable')}
            </ErrorLine>
          )}

          {submitFailed && (
            <Notice
              tone="warning"
              role="alert"
              errorId="oneClickSubmitFailed"
              title={t('nearIntentsDepositAddressFailedTitle')}
              data-testid="near-intents-submit-error"
            >
              {t('nearIntentsDepositAddressFailed')}
            </Notice>
          )}
        </div>
      </HomeGroupPaneBody>

      <SendTokenDrawer
        open={sendDrawerOpen}
        onOpenChange={setSendDrawerOpen}
        catalog={catalog}
        selectedChainId={chain.id}
        selectedTokenAssetId={token.asset.assetId}
        onSelect={selectToken}
      />
      <ReceiveTokenDrawer
        open={receiveDrawerOpen}
        onOpenChange={setReceiveDrawerOpen}
        outputs={token.outputs}
        selectedOutputAssetId={output.assetId}
        originSymbol={token.symbol}
        originChainName={chainName}
        onSelect={selectOutput}
      />
    </>
  );
};
