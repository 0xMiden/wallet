import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { RpcClient } from '@miden-sdk/miden-sdk/lazy';
import { addDays, format, formatDistanceToNow } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';
import { ScreenHeader } from 'components/ScreenHeader';
import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { EVM_AGGLAYER_NETWORK_ID, MIDEN_AGGLAYER_FAUCET_ID } from 'lib/agglayer/b2agg/constant';
import { bridgeEpochSend } from 'lib/epoch';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSendTransaction,
  requestSpeculateInvalidate,
  requestSWTransactionProcessing
} from 'lib/miden/activity';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { NoteTypeEnum } from 'lib/miden/types';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { goBack, HistoryAction, navigate, Redirect, useLocation } from 'lib/woozie';
import { detectAddressChain, isValidRecipientAddress } from 'utils/miden';

import { BRIDGE_OUTPUT_TOKEN_SYMBOL, getBridgeNetwork, BridgeNetworkId } from './bridge-networks';
import { dateTimeToRecallBlocks, RecallCalendarDrawer } from './RecallCalendarDrawer';
import { clearSendDraft } from './send-draft';
import { BridgeRoute, UIToken } from './types';
import { useEpochQuote } from './useEpochQuote';

/**
 * Full-screen send review page (`/send/review?amount=…&to=…&tokenId=…`).
 *
 * Owns the whole transaction-creation pipeline: the send form at `/send` only
 * collects recipient/amount/token and hands them over via query params (plus a
 * send-draft for back-restore — see `send-draft.ts`). Rendered outside
 * TabLayout via FullScreenPage, so there is no tab bar; back is the
 * ScreenHeader's back button (or hardware back via MobileBackBridge on
 * mobile).
 */
export const ReviewTransaction: React.FC = () => {
  const { t } = useTranslation();
  const { search } = useLocation();
  const { fullPage } = useAppEnv();
  const { publicKey } = useAccount();

  const { signTransaction } = useMidenContext();

  const { amount, to, tokenId, network, route } = useMemo(() => {
    const params = new URLSearchParams(search);
    const networkParam = params.get('network');
    const routeParam = params.get('route');
    return {
      amount: params.get('amount') ?? '',
      to: params.get('to') ?? '',
      tokenId: params.get('tokenId') ?? '',
      network: (networkParam ?? undefined) as BridgeNetworkId | undefined,
      route: (routeParam ?? undefined) as BridgeRoute | undefined
    };
  }, [search]);

  // A 0x recipient bridges to an EVM chain instead of a same-chain Miden send.
  const isBridge = !!to && detectAddressChain(to) === 'ethereum';
  const bridgeNetworkObj = getBridgeNetwork(network);

  // Re-derive the UIToken from balances (same mapping as SendManager's
  // preselect effect) — the URL only carries the token id.
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  const token = useMemo<UIToken | undefined>(() => {
    const match = balanceData?.find(b => b.tokenId === tokenId);
    if (!match) return undefined;
    return {
      id: match.tokenId,
      name: match.metadata.symbol,
      decimals: match.metadata.decimals,
      balance: match.balance,
      fiatPrice: match.fiatPrice
    };
  }, [balanceData, tokenId]);

  // Cross-chain sends over the Slow (Agglayer) route only carry the dedicated
  // bridgeable faucet token; Fast (Epoch) bridges any token.
  const isBridgeableToken =
    !!token && accountIdStringToSdk(token.id.toLowerCase()).toString() === MIDEN_AGGLAYER_FAUCET_ID.toLowerCase();

  const amountBaseUnits = useMemo(() => {
    if (!token || !amount) return undefined;
    try {
      return stringToBigInt(amount, token.decimals);
    } catch {
      return undefined;
    }
  }, [token, amount]);

  // Forward-quote the USDC output for the Fast (Epoch) route — drives the
  // "you receive" row.
  const epochQuote = useEpochQuote({
    amount: amountBaseUnits,
    faucetId: token?.id,
    destinationAddress: to,
    senderPublicKey: publicKey ?? undefined,
    enabled: isBridge
  });

  // Private by default; the per-send toggle was removed from the UI. Only the
  // E2E hook below can flip it.
  const [sharePrivately, setSharePrivately] = useState(true);

  // E2E-only hook: the harness can't pick a PUBLIC send by clicking (no UI
  // toggle), so expose a setter while the review page is mounted. Mirrors the
  // __TEST_STORE__ gate. Zero production impact.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    (globalThis as any).__TEST_SET_SHARE_PRIVATELY__ = (v: boolean) => setSharePrivately(v);
    return () => {
      delete (globalThis as any).__TEST_SET_SHARE_PRIVATELY__;
    };
  }, []);

  const [recallDate, setRecallDate] = useState<Date | undefined>(undefined);
  const [recallTime, setRecallTime] = useState('12:00');
  const [recallBlocks, setRecallBlocks] = useState<string | undefined>(undefined);
  const [showCalendar, setShowCalendar] = useState(false);

  // Default every same-chain send to a 7-day reclaim (expiration) height. Fetch
  // the current block height once on mount and seed recallDate/recallBlocks. The
  // user can override via the "Edit" link, which opens RecallCalendarDrawer.
  // A bridge has no Miden-side expiration row, so skip the RPC round-trip.
  useEffect(() => {
    if (isBridge) return;
    let cancelled = false;
    ensureSdkWasmReady()
      .then(() => {
        if (cancelled) return;
        const rpc = new RpcClient(getRpcEndpoint());
        return rpc.getBlockHeaderByNumber().then(header => {
          if (cancelled) return;
          const date = addDays(new Date(), 7);
          setRecallDate(date);
          setRecallTime(format(date, 'HH:mm'));
          setRecallBlocks(String(dateTimeToRecallBlocks(date, header.blockNum())));
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isBridge]);

  // Leaving review = leaving the send flow: drop any cached speculative prove
  // and mark in-flight ones stale. (SendManager's typing-time speculation
  // deliberately skips invalidation when handing off to this page.)
  useEffect(() => {
    if (process.env.MIDEN_USE_SPECULATIVE_PROVING !== 'true') return;
    if (!isExtension()) return;
    return () => {
      requestSpeculateInvalidate();
    };
  }, []);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  // Hand off to the full-screen in-progress page. GeneratingTransactionPage is
  // self-driving: it runs the tx loop on SW-less platforms, polls per-stage
  // progress for `txId`, stashes the Midenscan hash and flips to the success
  // receipt on completion — failure UX also lives there. Replace, not push, so
  // back from the progress page skips the now-stale review params.
  const goToGeneratingTransaction = useCallback(
    (txId: string) => {
      clearSendDraft();
      navigate(
        `${fullPage ? '/generating-transaction-full' : '/generating-transaction'}/${encodeURIComponent(txId)}`,
        HistoryAction.Replace
      );
    },
    [fullPage]
  );

  const onSubmit = useCallback(async () => {
    if (isSubmitting || !token || !publicKey) return;
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      // Drop any hash from a previous completed tx before starting a fresh one,
      // so the in-progress page can't briefly flash a stale "View on Midenscan"
      // button pointing at the previous hash.
      useWalletStore.getState().setLastCompletedTxHash(null);

      // Cross-chain (0x) recipient → bridge instead of a Miden send. Both routes
      // mirror a normal send: create the `bridged-send` row first, then navigate
      // to the generating-transaction screen WITH its txId so the screen tracks
      // the real row (no navigate-first race / success flash). Errors raised
      // before the row exists (e.g. a failed Epoch quote) stay on this page.
      if (isBridge) {
        // Agglayer (Slow) can only bridge the dedicated agglayer faucet token.
        if (route === 'agglayer' && !isBridgeableToken) {
          setSubmitError(t('onlyBridgeableTokenSupported'));
          setIsSubmitting(false);
          return;
        }
        const amountBase = stringToBigInt(amount, token.decimals);
        if (route === 'agglayer') {
          const txId = await initiateB2AggBridge({
            amount: amountBase,
            destinationAddress: to as `0x${string}`,
            senderPublicKey: publicKey,
            destinationNetwork: EVM_AGGLAYER_NETWORK_ID
          });
          if (isExtension()) requestSWTransactionProcessing();
          goToGeneratingTransaction(txId);
        } else {
          // Epoch creates its row mid-solve; `onRowCreated` fires the moment it
          // exists so we navigate then (the rest of the solve runs in the
          // background while the screen drives the row to completion).
          await bridgeEpochSend({
            amount: amountBase,
            faucetId: token.id,
            destinationAddress: to as `0x${string}`,
            senderPublicKey: publicKey,
            deps: { signTransaction, guardianProvider: zustandProvider },
            onRowCreated: goToGeneratingTransaction
          });
        }
        return;
      }

      // Step 1: Create the transaction (enqueues a Dexie row).
      const txId = await initiateSendTransaction(
        publicKey,
        to,
        token.id,
        sharePrivately ? NoteTypeEnum.Private : NoteTypeEnum.Public,
        stringToBigInt(amount, token.decimals),
        recallBlocks ? parseInt(recallBlocks) : undefined,
        isDelegateProofEnabled()
      );

      if (isExtension()) {
        // On extension the SW owns the tx loop — nudge it.
        requestSWTransactionProcessing();
      }

      goToGeneratingTransaction(txId);
    } catch (e) {
      console.error(e);
      setSubmitError(e instanceof Error ? e.message : String(e));
      setIsSubmitting(false);
    }
  }, [
    isSubmitting,
    token,
    publicKey,
    to,
    sharePrivately,
    amount,
    recallBlocks,
    isBridge,
    route,
    isBridgeableToken,
    signTransaction,
    goToGeneratingTransaction,
    t
  ]);

  // Deep-link guards — after all hooks. Address/amount are checkable
  // immediately; token existence and balance only once balances load. A 0x
  // recipient is valid here too: it routes through the bridge.
  const paramsInvalid = !tokenId || !(parseFloat(amount) > 0) || !isValidRecipientAddress(to);
  // A cross-chain send must know its destination network, otherwise the review
  // rows and the submit path have nothing to act on.
  const bridgeParamsInvalid = isBridge && !bridgeNetworkObj;
  const tokenInvalid = !!balanceData && (!token || parseFloat(amount) > token.balance);
  if (paramsInvalid || bridgeParamsInvalid || tokenInvalid) {
    return <Redirect to="/send" />;
  }

  const expirationLabel = recallDate
    ? (() => {
        const rel = formatDistanceToNow(recallDate, { addSuffix: true });
        return rel.charAt(0).toUpperCase() + rel.slice(1);
      })()
    : t('none');

  // Agglayer carries the bridgeable token 1:1; the Fast route forward-quotes the
  // USDC output. Show a skeleton only while the Fast quote is still loading.
  const youReceiveLoading = isBridge && route !== 'agglayer' && epochQuote.loading;
  const youReceiveAmount = route === 'agglayer' ? amount : epochQuote.amount;
  const youReceiveLabel =
    youReceiveAmount != null
      ? `≈ ${youReceiveAmount} ${BRIDGE_OUTPUT_TOKEN_SYMBOL}`.trim()
      : BRIDGE_OUTPUT_TOKEN_SYMBOL;
  const routeLabel = route === 'agglayer' ? t('slow') : t('fast');
  const arrivalLabel = route === 'agglayer' ? t('slowArrival') : t('fastArrival');

  return (
    <div className="flex flex-col h-full min-h-0 bg-app-bg">
      <ScreenHeader
        title={t('reviewDetails')}
        backLabel={t('back')}
        onBack={() => goBack()}
        className="mx-4 shrink-0"
      />
      <div className="flex-1 min-h-0">
        <ReviewLayout
          hero={<ReviewAmount symbol={token?.name ?? ''} amount={amount} label={t('youAreSending')} />}
          primary={{
            label: t('sendPayment'),
            onPress: onSubmit,
            loading: isSubmitting,
            disabled: isSubmitting,
            'data-testid': 'send-review-submit'
          }}
          error={submitError}
        >
          <ReviewRow label={t('to')} value={to} />

          <ReviewRow label={t('network')}>
            <span className="inline-flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />
              {isBridge ? (bridgeNetworkObj?.name ?? t('ethereum')) : t('miden')}
            </span>
          </ReviewRow>

          {isBridge ? (
            <>
              <ReviewRow label={t('route')} value={`${routeLabel} ${arrivalLabel}`} />
              <ReviewRow label={t('youReceive')}>
                {youReceiveLoading ? (
                  <div className="h-7 w-32 animate-pulse rounded bg-heading-gray/10" />
                ) : (
                  youReceiveLabel
                )}
              </ReviewRow>
            </>
          ) : (
            <ReviewRow
              label={t('expirationDate')}
              onEdit={() => setShowCalendar(true)}
              editLabel={t('edit')}
              note={recallDate ? t('recallReturnsNote', { amount: `${amount} ${token?.name ?? ''}` }) : undefined}
            >
              {expirationLabel}
            </ReviewRow>
          )}
        </ReviewLayout>
      </div>

      {!isBridge && (
        <RecallCalendarDrawer
          open={showCalendar}
          onOpenChange={setShowCalendar}
          recallDate={recallDate}
          recallTime={recallTime}
          onRecallBlocksChange={setRecallBlocks}
          onRecallDateChange={setRecallDate}
          onRecallTimeChange={setRecallTime}
        />
      )}
    </div>
  );
};
