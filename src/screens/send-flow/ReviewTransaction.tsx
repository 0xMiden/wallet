import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { addDays, format, formatDistanceToNow } from 'date-fns';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import { ReviewAmount, ReviewLayout, ReviewRow } from 'components/review';
import { ScreenHeader } from 'components/ScreenHeader';
import { confirmSensitiveAction } from 'lib/biometric';
import { stringToBigInt } from 'lib/i18n/numbers';
import {
  initiateSendTransaction,
  requestSpeculateInvalidate,
  requestSWTransactionProcessing
} from 'lib/miden/activity';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { NoteTypeEnum } from 'lib/miden/types';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { goBack, HistoryAction, navigate, Redirect, useLocation } from 'lib/woozie';
import { isValidMidenAddress } from 'utils/miden';

import { dateTimeToRecallBlocks, RecallCalendarDrawer } from './RecallCalendarDrawer';
import { clearSendDraft } from './send-draft';
import { UIToken } from './types';

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

  const { amount, to, tokenId } = useMemo(() => {
    const params = new URLSearchParams(search);
    return {
      amount: params.get('amount') ?? '',
      to: params.get('to') ?? '',
      tokenId: params.get('tokenId') ?? ''
    };
  }, [search]);

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

  // Default every send to a 7-day reclaim (expiration) offset. recallBlocks is a
  // RELATIVE block offset — the current chain height is added later, once, by the
  // SDK interface — so no block-height fetch is needed here. The user can override
  // via the "Edit" link, which opens RecallCalendarDrawer.
  useEffect(() => {
    const date = addDays(new Date(), 7);
    setRecallDate(date);
    setRecallTime(format(date, 'HH:mm'));
    setRecallBlocks(String(dateTimeToRecallBlocks(date)));
  }, []);

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

  const onSubmit = useCallback(async () => {
    if (isSubmitting || !token || !publicKey) return;
    setIsSubmitting(true);
    // Re-confirm this user-initiated send with biometrics when the user has them
    // enabled. Hot signing is silent again (guardian sync / auto-consume must not
    // prompt), so this is the app-layer gate that keeps value transfers explicit.
    // Set submitting first so the async prompt can't be double-triggered.
    if (!(await confirmSensitiveAction('Confirm your send'))) {
      setIsSubmitting(false);
      return;
    }
    try {
      // Drop any hash from a previous completed tx before starting a fresh one,
      // so the in-progress page can't briefly flash a stale "View on Midenscan"
      // button pointing at the previous hash.
      useWalletStore.getState().setLastCompletedTxHash(null);

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

      // Step 2: Hand off to the full-screen in-progress page immediately.
      // GeneratingTransactionPage is self-driving: it runs the tx loop on
      // SW-less platforms, polls per-stage progress for `txId`, stashes the
      // Midenscan hash and flips to the success receipt on completion —
      // failure UX also lives there. (TransactionProgressModal renders
      // nothing; it's a headless queue driver.) Replace, not push, so back
      // from the progress page skips the now-stale review params.
      clearSendDraft();
      navigate(
        `${fullPage ? '/generating-transaction-full' : '/generating-transaction'}/${encodeURIComponent(txId)}`,
        HistoryAction.Replace
      );
    } catch (e) {
      console.error(e);
      setIsSubmitting(false);
    }
  }, [isSubmitting, token, publicKey, to, sharePrivately, amount, recallBlocks, fullPage]);

  // Deep-link guards — after all hooks. Address/amount are checkable
  // immediately; token existence and balance only once balances load.
  const paramsInvalid = !tokenId || !(parseFloat(amount) > 0) || !isValidMidenAddress(to);
  const tokenInvalid = !!balanceData && (!token || parseFloat(amount) > token.balance);
  if (paramsInvalid || tokenInvalid) {
    return <Redirect to="/send" />;
  }

  const expirationLabel = recallDate
    ? (() => {
        const rel = formatDistanceToNow(recallDate, { addSuffix: true });
        return rel.charAt(0).toUpperCase() + rel.slice(1);
      })()
    : t('none');

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
          primary={{ label: t('sendPayment'), onPress: onSubmit, 'data-testid': 'send-review-submit' }}
        >
          <ReviewRow label={t('to')} value={to} />

          <ReviewRow label={t('network')}>
            <span className="inline-flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-primary-500" />
              {t('miden')}
            </span>
          </ReviewRow>

          <ReviewRow
            label={t('expirationDate')}
            onEdit={() => setShowCalendar(true)}
            editLabel={t('edit')}
            note={recallDate ? t('recallReturnsNote', { amount: `${amount} ${token?.name ?? ''}` }) : undefined}
          >
            {expirationLabel}
          </ReviewRow>
        </ReviewLayout>
      </div>

      <RecallCalendarDrawer
        open={showCalendar}
        onOpenChange={setShowCalendar}
        recallDate={recallDate}
        recallTime={recallTime}
        onRecallBlocksChange={setRecallBlocks}
        onRecallDateChange={setRecallDate}
        onRecallTimeChange={setRecallTime}
      />
    </div>
  );
};
