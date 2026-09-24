import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { addDays, addSeconds, format, formatDistanceToNow } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { useNetworkFeeEstimate } from 'app/hooks/useNetworkFeeEstimate';
import { Button, ButtonVariant } from 'components/Button';
import { NetworkLogo } from 'components/NetworkChip';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { SpendingLimitChallenge, SpendingLimitChallengeProps } from 'components/SpendingLimitChallenge';
import { TokenLogo } from 'components/TokenLogo';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Hero } from 'components/ui/Hero';
import { Skeleton } from 'components/ui/Skeleton';
import { initiateB2AggBridge } from 'lib/agglayer/b2agg';
import { EVM_AGGLAYER_NETWORK_ID } from 'lib/agglayer/b2agg/constant';
import { confirmSensitiveAction } from 'lib/biometric';
import { bridgeEpochSend } from 'lib/epoch';
import { stringToBigInt } from 'lib/i18n/numbers';
import { initiateSendTransaction, requestSWTransactionProcessing } from 'lib/miden/activity';
import { IConsumedAssetTotal } from 'lib/miden/db/types';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { useMidenContext } from 'lib/miden/front/client';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import {
  isSpendingLimitPriceUnavailable,
  SpendingLimitAuthorization,
  spendingLimitAssessmentFromError
} from 'lib/miden/spending-limits/types';
import { NoteTypeEnum } from 'lib/miden/types';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { classifyError } from 'lib/telemetry';
import { goBack, HistoryAction, navigate, Redirect, useLocation } from 'lib/woozie';
import { detectAddressChain, isValidRecipientAddress } from 'utils/miden';

import { approxFiatAmount } from './amount-format';
import { BRIDGE_OUTPUT_TOKEN_SYMBOL, getBridgeNetwork, BridgeNetworkId } from './bridge-networks';
import { dateTimeToRecallBlocks, RecallCalendarDrawer, SECONDS_PER_BLOCK } from './RecallCalendarDrawer';
import { clearSendDraft } from './send-draft';
import { enterSendFlow, reportSendStep, settleSendFlow } from './send-telemetry';
import { SendStepLayout } from './SendStepLayout';
import { BridgeRoute, UIToken } from './types';
import { uiTokenFromBalance } from './ui-token';
import { useEpochQuote } from './useEpochQuote';

/**
 * Full-screen send review page (`/send/review?amount=…&to=…&tokenId=…`).
 *
 * Owns the whole transaction-creation pipeline: the send form at `/send` only
 * collects recipient/amount/token and hands them over via query params (plus a
 * send-draft for back-restore — see `send-draft.ts`). Rendered outside
 * TabLayout via FullScreenPage, so there is no tab bar; back is
 * SendStepLayout's (FlowLayout's) PageHeader back button (or hardware back via
 * MobileBackBridge on mobile).
 */
export const ReviewTransaction: React.FC = () => {
  const { t } = useTranslation();
  const networkFee = useNetworkFeeEstimate();
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

  // Re-derive the UIToken from balances with SendManager's builder; the URL
  // only carries the token id.
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balanceData } = useAllBalances(publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const token = useMemo<UIToken | undefined>(() => {
    const match = balanceData?.find(b => b.tokenId === tokenId);
    return match && uiTokenFromBalance(match, tokenPrices);
  }, [balanceData, tokenId, tokenPrices]);

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
  // "Never" = no reclaim height → the send goes out as a plain P2ID note. Tracked
  // separately from `recallDate` (undefined both before seeding AND when "Never" is
  // chosen) so the expiration label can tell the two apart.
  const [recallNever, setRecallNever] = useState(false);
  // Marks the recall height as user-chosen (a date or "Never") so the async
  // default-seeding effect below never clobbers an explicit choice (race guard).
  const recallTouchedRef = useRef(false);

  // E2E-only hook: the shortest window RecallCalendarDrawer offers is 30 minutes,
  // so no click path produces a recall a test can wait out — and without one, the
  // whole reclaim half of a send (the only path where a user's funds come BACK)
  // is unreachable from any E2E run. The harness assigns
  // `globalThis.__TEST_RECALL_BLOCKS__` (a RELATIVE blocks offset, or null for
  // "Never") before entering the send flow and this page adopts it exactly as if
  // the user had picked it in the drawer. Same MIDEN_E2E_TEST gate as
  // __TEST_SET_SHARE_PRIVATELY__ above; zero production impact.
  //
  // Declared BEFORE the seeding effect below so `recallTouchedRef` is already set
  // when that effect runs on the same commit — the 7-day default cannot clobber
  // an armed value.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    if (isBridge) return;
    const armed = (globalThis as unknown as { __TEST_RECALL_BLOCKS__?: number | null }).__TEST_RECALL_BLOCKS__;
    if (armed === undefined) return;
    recallTouchedRef.current = true;
    if (armed === null) {
      setRecallNever(true);
      setRecallDate(undefined);
      setRecallBlocks(undefined);
      return;
    }
    const date = addSeconds(new Date(), armed * SECONDS_PER_BLOCK);
    setRecallNever(false);
    setRecallDate(date);
    setRecallTime(format(date, 'HH:mm'));
    setRecallBlocks(String(armed));
  }, [isBridge]);

  // Default every same-chain send to a 7-day reclaim (expiration) offset. The
  // user can override via the "Edit" link, which opens RecallCalendarDrawer.
  // recallBlocks is a RELATIVE blocks-until-recall offset — the SDK-interface
  // layer converts it to an absolute height at send time, so no block-height
  // fetch is needed here. A bridge has no Miden-side expiration row.
  useEffect(() => {
    if (isBridge) return;
    // Don't clobber an explicit user choice (a date or "Never") if this re-runs.
    if (recallTouchedRef.current) return;
    const date = addDays(new Date(), 7);
    setRecallDate(date);
    setRecallTime(format(date, 'HH:mm'));
    setRecallBlocks(String(dateTimeToRecallBlocks(date)));
  }, [isBridge]);

  // Recall-height handlers. All mark the choice as user-made so the seeding
  // effect above won't overwrite it. "Never" clears the height entirely → P2ID.
  const handleRecallDateChange = useCallback((date: Date | undefined) => {
    recallTouchedRef.current = true;
    if (date) setRecallNever(false);
    setRecallDate(date);
  }, []);
  const handleRecallBlocksChange = useCallback((blocks: string) => {
    recallTouchedRef.current = true;
    setRecallBlocks(blocks);
  }, []);
  const handleRecallNever = useCallback(() => {
    recallTouchedRef.current = true;
    setRecallNever(true);
    setRecallDate(undefined);
    setRecallBlocks(undefined);
  }, []);

  // Leaving review without submitting ends the `send` flow the form began.
  // Without this the handle would stay open past the send flow entirely and the
  // next send would adopt it, inheriting a duration that is not its own.
  // Already-settled flows are untouched, so a completed submit is not
  // re-reported by the navigation away from this page.
  useEffect(() => {
    // Reaching review is the most informative single fact about an abandoned
    // send: the user had chosen a recipient, a token and an amount, and stopped
    // at the last screen before committing. That is a very different problem
    // from giving up on the amount field, and only `step` distinguishes them.
    reportSendStep('review');
    return () => {
      settleSendFlow(flow => flow.cancel());
    };
  }, []);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [spendingLimitChallenge, setSpendingLimitChallenge] =
    useState<Pick<SpendingLimitChallengeProps, 'assessment' | 'spends' | 'unpriced'>>();
  const assessSpendingLimit = useWalletStore(state => state.assessSpendingLimit);
  const readSpendingLimit = useWalletStore(state => state.readSpendingLimit);
  // The account's spending-limit revision never crosses the intercom port - `serializeError` /
  // `deserializeError` (`lib/intercom/helpers.ts`) carry only `code` and, for this error, `symbol`
  // - so the unpriced challenge reads the account's current revision fresh, the same value
  // `authorizationMatches` re-reads server-side at redemption.
  const openUnpricedChallenge = useCallback(
    async (spends: readonly IConsumedAssetTotal[]): Promise<boolean> => {
      if (!publicKey) return false;
      const configuration = await readSpendingLimit(publicKey);
      if (configuration === undefined) return false;
      setSpendingLimitChallenge({
        unpriced: { accountId: publicKey, spends: [...spends], revision: configuration.revision }
      });
      return true;
    },
    [publicKey, readSpendingLimit]
  );
  // `token` is undefined until balances load; an absent token is handled by the
  // deep-link guard below, so only a LOADED token with an unreadable scale
  // blocks the CTA.
  const scaleIsUnknown = token !== undefined && !token.scaleIsKnown;

  // Hand off to the full-screen in-progress page. GeneratingTransactionPage is
  // self-driving: it runs the tx loop on SW-less platforms, polls per-stage
  // progress for `txId`, stashes the Midenscan hash and flips to the success
  // receipt on completion — failure UX also lives there. Replace, not push, so
  // back from the progress page skips the now-stale review params.
  const goToGeneratingTransaction = useCallback(
    (txId: string) => {
      // The single success funnel for all three submit paths (Miden, Agglayer,
      // Epoch): a transaction row now exists, which is what "the user sent"
      // means here. Its later on-chain fate belongs to the progress screen.
      settleSendFlow(flow => flow.complete());
      clearSendDraft();
      navigate(
        `${fullPage ? '/generating-transaction-full' : '/generating-transaction'}/${encodeURIComponent(txId)}`,
        HistoryAction.Replace
      );
    },
    [fullPage]
  );

  const runSameChainSend = useCallback(
    async (authorization?: SpendingLimitAuthorization) => {
      if (!token || !publicKey || amountBaseUnits === undefined) return;
      if (authorization !== undefined && authorization.accountId !== publicKey) {
        setSpendingLimitChallenge(undefined);
        return;
      }
      setIsSubmitting(true);
      setSubmitError(undefined);
      setSpendingLimitChallenge(undefined);
      // Biometrics already passed, or this is the spending-limit authorization
      // that actually submits. Re-open a flow a previous error already settled.
      enterSendFlow();
      reportSendStep('submitting');
      try {
        useWalletStore.getState().setLastCompletedTxHash(null);
        const commonArguments = [
          publicKey,
          to,
          token.id,
          sharePrivately ? NoteTypeEnum.Private : NoteTypeEnum.Public,
          amountBaseUnits,
          recallBlocks ? parseInt(recallBlocks) : undefined,
          isDelegateProofEnabled()
        ] as const;
        const txId =
          authorization === undefined
            ? await initiateSendTransaction(...commonArguments)
            : await initiateSendTransaction(...commonArguments, authorization);
        if (isExtension()) requestSWTransactionProcessing();
        goToGeneratingTransaction(txId);
      } catch (error) {
        console.error(error);
        const spends = [{ faucetId: token.id, amount: amountBaseUnits }];
        const assessment = spendingLimitAssessmentFromError(error);
        if (assessment !== undefined) {
          setSpendingLimitChallenge({ assessment, spends });
          setIsSubmitting(false);
          return;
        }
        // `openUnpricedChallenge` reads spending-limit config and can itself throw. Caught here so
        // that failure still lands on the fallback error message and a re-enabled button below,
        // rather than skipping past both `setIsSubmitting(false)` calls and freezing the CTA.
        let opened = false;
        try {
          opened = isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(spends));
        } catch (challengeError) {
          console.error(challengeError);
        }
        if (opened) {
          setIsSubmitting(false);
          return;
        }
        settleSendFlow(flow => flow.fail(classifyError(error)));
        setSubmitError(error instanceof Error ? error.message : String(error));
        setIsSubmitting(false);
      }
    },
    [
      amountBaseUnits,
      goToGeneratingTransaction,
      openUnpricedChallenge,
      publicKey,
      recallBlocks,
      sharePrivately,
      to,
      token
    ]
  );

  const runBridgeSend = useCallback(
    async (authorization?: SpendingLimitAuthorization) => {
      if (!token || !publicKey || amountBaseUnits === undefined) return;
      if (authorization !== undefined && authorization.accountId !== publicKey) {
        setSpendingLimitChallenge(undefined);
        return;
      }
      setIsSubmitting(true);
      setSubmitError(undefined);
      setSpendingLimitChallenge(undefined);
      // Biometrics already passed, or this is the spending-limit authorization
      // that actually submits. Re-open a flow a previous error already settled.
      enterSendFlow();
      reportSendStep('submitting');
      try {
        useWalletStore.getState().setLastCompletedTxHash(null);
        if (route === 'agglayer') {
          const txId = await initiateB2AggBridge({
            amount: amountBaseUnits,
            faucetId: token.id,
            destinationAddress: to as `0x${string}`,
            senderPublicKey: publicKey,
            destinationNetwork: EVM_AGGLAYER_NETWORK_ID,
            spendingLimitAuthorization: authorization
          });
          if (isExtension()) requestSWTransactionProcessing();
          goToGeneratingTransaction(txId);
        } else {
          await bridgeEpochSend({
            amount: amountBaseUnits,
            faucetId: token.id,
            destinationAddress: to as `0x${string}`,
            senderPublicKey: publicKey,
            deps: { signTransaction, guardianProvider: zustandProvider },
            onRowCreated: goToGeneratingTransaction,
            spendingLimitAuthorization: authorization
          });
        }
      } catch (error) {
        console.error(error);
        const spends = [{ faucetId: token.id, amount: amountBaseUnits }];
        const assessment = spendingLimitAssessmentFromError(error);
        if (assessment !== undefined) {
          setSpendingLimitChallenge({ assessment, spends });
          setIsSubmitting(false);
          return;
        }
        // See `runSameChainSend`: guard against `openUnpricedChallenge` itself throwing, or a
        // storage read failure here leaves the CTA disabled forever with no visible error.
        let opened = false;
        try {
          opened = isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(spends));
        } catch (challengeError) {
          console.error(challengeError);
        }
        if (opened) {
          setIsSubmitting(false);
          return;
        }
        settleSendFlow(flow => flow.fail(classifyError(error)));
        setSubmitError(error instanceof Error ? error.message : String(error));
        setIsSubmitting(false);
      }
    },
    [amountBaseUnits, goToGeneratingTransaction, openUnpricedChallenge, publicKey, route, signTransaction, to, token]
  );

  const onSubmit = useCallback(async () => {
    if (isSubmitting || !token || !publicKey || amountBaseUnits === undefined) return;
    if (!token.scaleIsKnown) {
      setSubmitError(t('unknownTokenScale'));
      return;
    }
    const spends = [{ faucetId: token.id, amount: amountBaseUnits }];
    setIsSubmitting(true);
    setSubmitError(undefined);
    try {
      const assessment = await assessSpendingLimit(publicKey, spends);
      if (assessment !== undefined && assessment.breach !== undefined) {
        setSpendingLimitChallenge({ assessment, spends });
        setIsSubmitting(false);
        return;
      }
      if (!(await confirmSensitiveAction('Confirm your send'))) {
        setIsSubmitting(false);
        return;
      }
      if (isBridge) {
        await runBridgeSend();
      } else {
        await runSameChainSend();
      }
    } catch (error) {
      console.error(error);
      // See `runSameChainSend`: guard against `openUnpricedChallenge` itself throwing, or a
      // storage read failure here leaves the CTA disabled forever with no visible error.
      let opened = false;
      try {
        opened = isSpendingLimitPriceUnavailable(error) && (await openUnpricedChallenge(spends));
      } catch (challengeError) {
        console.error(challengeError);
      }
      if (opened) {
        setIsSubmitting(false);
        return;
      }
      setSubmitError(error instanceof Error ? error.message : String(error));
      setIsSubmitting(false);
    }
  }, [
    amountBaseUnits,
    assessSpendingLimit,
    isBridge,
    isSubmitting,
    openUnpricedChallenge,
    publicKey,
    runBridgeSend,
    runSameChainSend,
    t,
    token
  ]);

  const handleSpendingLimitResult = useCallback(
    (authorization: SpendingLimitAuthorization | undefined) => {
      setSpendingLimitChallenge(undefined);
      if (authorization !== undefined) {
        if (isBridge) {
          void runBridgeSend(authorization);
        } else {
          void runSameChainSend(authorization);
        }
      }
    },
    [isBridge, runBridgeSend, runSameChainSend]
  );

  // The account is the only identity both the `assessment` and `unpriced` challenge shapes carry
  // (usd/spends amounts don't survive as comparable fields on the domain types any more), so this
  // guard closes the drawer if the active account changes while it's open; a stale credential for
  // any other reason is still caught by the backend's own authorization re-check at redemption.
  useEffect(() => {
    if (spendingLimitChallenge === undefined) return;
    const accountId = spendingLimitChallenge.assessment?.accountId ?? spendingLimitChallenge.unpriced?.accountId;
    if (accountId !== publicKey) {
      setSpendingLimitChallenge(undefined);
    }
  }, [publicKey, spendingLimitChallenge]);

  // Deep-link guards — after all hooks. Address/amount are checkable
  // immediately; token existence and balance only once balances load. A 0x
  // recipient is valid here too: it routes through the bridge. Self-sends are
  // rejected (SendManager blocks them at entry; this covers direct routing).
  const paramsInvalid =
    !tokenId || !(parseFloat(amount) > 0) || !isValidRecipientAddress(to) || sameWalletAccountId(to, publicKey ?? '');
  // A cross-chain send must know its destination network, otherwise the review
  // rows and the submit path have nothing to act on.
  const bridgeParamsInvalid = isBridge && !bridgeNetworkObj;
  const tokenInvalid = !!balanceData && (!token || parseFloat(amount) > token.balance);
  if (paramsInvalid || bridgeParamsInvalid || tokenInvalid) {
    return <Redirect to="/send" />;
  }

  // Label is derived from recallBlocks — the single source of truth for the send:
  //   undefined → plain P2ID (no recall) → "None" (or "Never" if explicitly chosen)
  //   set        → P2IDE, recallable ~(recallBlocks * SECONDS_PER_BLOCK) after SUBMIT
  // The offset is RELATIVE and gets converted to an absolute height at send time, so
  // reading the window off the offset (not the picked absolute instant) keeps the
  // displayed value matching what's actually broadcast no matter how long the user
  // lingers here. Near windows render precisely (< 3 min in seconds, < 30 min in
  // minutes), longer ones as a coarse relative phrase.
  const expirationLabel = (() => {
    if (!recallBlocks) return recallNever ? t('never') : t('none');
    const secs = parseInt(recallBlocks, 10) * SECONDS_PER_BLOCK;
    if (secs < 180) return t('expiresInSeconds', { seconds: String(Math.max(1, secs)) });
    if (secs < 1800) return t('expiresInMinutes', { minutes: String(Math.ceil(secs / 60)) });
    const rel = formatDistanceToNow(addSeconds(new Date(), secs), { addSuffix: true });
    return rel.charAt(0).toUpperCase() + rel.slice(1);
  })();

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

  const fiatValue =
    token && token.scaleIsKnown && token.fiatPrice > 0 ? parseFloat(amount) * token.fiatPrice : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg">
      <NetworkModeBanner />
      <SendStepLayout
        title={t('reviewDetails')}
        onBack={() => goBack()}
        footer={
          <div className="flex flex-col gap-2">
            {(scaleIsUnknown || submitError) && (
              <p data-testid="review-error" className="text-center text-sm text-red-500">
                {scaleIsUnknown ? t('unknownTokenScale') : submitError}
              </p>
            )}
            <Button
              type="button"
              title={t('sendPayment')}
              variant={ButtonVariant.Primary}
              accent="send"
              onClick={onSubmit}
              isLoading={isSubmitting}
              // Disabled rather than merely rejected on press: the reason is known
              // before the user reaches for the button, and letting them tap a live
              // CTA only to be refused reads as a wallet fault rather than a
              // deliberate refusal.
              disabled={isSubmitting || scaleIsUnknown}
              data-testid="send-review-submit"
              className="w-full max-w-none"
            />
          </div>
        }
      >
        {/* The amount is the page's hero, in the same place as on the amount step. */}
        <Hero
          data-testid="review-amount"
          className="mt-3"
          visual={<TokenLogo symbol={token?.name ?? ''} size="2xl" />}
          value={`${amount} ${token?.name ?? ''}`}
          subtitle={fiatValue !== undefined ? t('approxFiatValue', { value: approxFiatAmount(fiatValue) }) : undefined}
        />

        <DetailCard className="mt-6">
          {/* The full address, never truncated: this is the last look before funds move. Set in body
              text rather than the bold value face, so it reads as something to check, not a headline. */}
          <DetailRow label={t('to')} stacked data-testid="review-row-to">
            <span className="text-body-sm break-all text-ink">{to}</span>
          </DetailRow>
          {/* A plain value with the network's mark, like every other row: a chip here read as a button. */}
          <DetailRow label={t('network')}>
            <span className="flex items-center gap-1.5">
              <NetworkLogo kind={isBridge ? 'ethereum' : 'miden'} />
              {isBridge ? (bridgeNetworkObj?.name ?? t('ethereum')) : t('miden')}
            </span>
          </DetailRow>

          {/* The exact fee is `baseFee x (floor(log2(cycles)) + 1)` and cycles are not known until
              the transaction is proven, so this quotes the upper bound the wallet already reserves
              against — the same amount the amount step withheld from `Available`. Absent on a
              zero-fee chain and before discovery; see `useNetworkFeeEstimate`. */}
          {networkFee && (
            // "Max" in the label already says the fee is an upper bound; the receipt shows what was paid.
            <DetailRow label={t('networkFeeMax')}>{networkFee}</DetailRow>
          )}

          {isBridge ? (
            <>
              <DetailRow label={t('route')}>{`${routeLabel} ${arrivalLabel}`}</DetailRow>
              <DetailRow label={t('youReceive')}>
                {youReceiveLoading ? <Skeleton className="h-6 w-28" /> : youReceiveLabel}
              </DetailRow>
            </>
          ) : (
            <DetailRow
              label={t('expires')}
              action={{ label: t('edit'), onClick: () => setShowCalendar(true) }}
              data-testid="review-row-expiration"
            >
              {expirationLabel}
            </DetailRow>
          )}
        </DetailCard>
        {/* The reassurance about an unclaimed payment is one caption under the card, not a paragraph
            squeezed into the value column. */}
        {!isBridge && recallBlocks ? (
          <p className="mt-3 px-4 text-caption text-muted" data-testid="review-recall-note">
            {t('recallReturnsNote', { amount: `${amount} ${token?.name ?? ''}` })}
          </p>
        ) : null}
      </SendStepLayout>

      {!isBridge && (
        <RecallCalendarDrawer
          open={showCalendar}
          onOpenChange={setShowCalendar}
          recallDate={recallDate}
          recallTime={recallTime}
          onRecallBlocksChange={handleRecallBlocksChange}
          onRecallDateChange={handleRecallDateChange}
          onRecallTimeChange={setRecallTime}
          onRecallNever={handleRecallNever}
        />
      )}
      {spendingLimitChallenge !== undefined && (
        <SpendingLimitChallenge
          assessment={spendingLimitChallenge.assessment}
          spends={spendingLimitChallenge.spends}
          unpriced={spendingLimitChallenge.unpriced}
          onResult={handleSpendingLimitResult}
        />
      )}
    </div>
  );
};
