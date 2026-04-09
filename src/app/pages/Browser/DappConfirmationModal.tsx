/**
 * React replacement for the legacy `confirmation-overlay.ts`.
 *
 * The old approach injected an HTML overlay into the dApp's webview via
 * `executeScript`, which forced the wallet to coordinate with the dApp's
 * own DOM and required a postMessage round-trip for approve/deny.
 *
 * In PR-1 the wallet UI is visible above the dApp (the React capsule sits
 * at z-60, the dApp webview is positioned underneath), so we can render
 * the confirmation modal directly in React on top of the wallet at z-70.
 * The user's approve/deny clicks call `dappConfirmationStore.resolveConfirmation`
 * directly — no executeScript, no DOM injection.
 *
 * The dApp content is hidden via `useDappWebView.setHidden(true)` while the
 * modal is shown — that path uses `executeScript` to set CSS visibility
 * inside the dApp's own DOM rather than resizing the native frame, which
 * avoids tripping the host viewport bug documented in `viewport-reset.ts`.
 */

import React, { type FC, useEffect, useRef } from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { useSprings } from 'lib/animation';
import type { DAppConfirmationRequest, DAppConfirmationResult } from 'lib/dapp-browser/confirmation-store';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';

interface DappConfirmationModalProps {
  request: DAppConfirmationRequest;
  /** Short, monospace-formatted account id used in the connection panel */
  accountId: string | null;
  /** Called when the user approves or denies. The store updates inside this callback. */
  onResolve: (result: DAppConfirmationResult) => void;
}

export const DappConfirmationModal: FC<DappConfirmationModalProps> = ({ request, accountId, onResolve }) => {
  const { t } = useTranslation();
  // PR-7: reduce-motion-aware springs.
  const springs = useSprings();
  const isTransaction = request.type === 'transaction' || request.type === 'consume';
  const appName = request.appMeta?.name || request.origin;
  const transactionMessages = request.transactionMessages ?? [];
  const canApprove = isTransaction || Boolean(accountId);

  // PR-7: focus management. On mount we store the element that was
  // focused before the modal opened, move focus to the first focusable
  // element inside the modal, trap Tab within the modal, and restore
  // focus to the original element on unmount. This gives keyboard and
  // screen-reader users a proper modal interaction without adding the
  // `react-focus-lock` dep the plan suggested — a ~30 LOC native
  // implementation covers the same ground for our single-modal case.
  const containerRef = useRef<HTMLDivElement>(null);
  const approveButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null;
    // Focus the primary action so pressing Enter confirms by default
    // (matches iOS / macOS confirm-dialog behavior). If the approve
    // button is disabled, focus falls back to the first interactive
    // element in the dialog (which will be the Deny button).
    const focusTarget =
      approveButtonRef.current && !approveButtonRef.current.disabled
        ? approveButtonRef.current
        : containerRef.current?.querySelector<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
    focusTarget?.focus();

    return () => {
      // Restore focus to whatever had it before the modal opened so
      // keyboard users don't lose their place.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hardware back / iOS swipe-back closes the modal as a deny.
  useMobileBackHandler(() => {
    handleDeny();
    return true;
  }, []);

  // PR-7: ESC key deny + Tab key focus trap.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDeny();
        return;
      }
      if (e.key === 'Tab') {
        const container = containerRef.current;
        if (!container) return;
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        const active = document.activeElement as HTMLElement | null;

        if (e.shiftKey) {
          if (active === first || !container.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !container.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDeny() {
    hapticLight();
    onResolve({ confirmed: false });
  }

  function handleApprove() {
    if (!canApprove) return;
    hapticMedium();
    onResolve({
      confirmed: true,
      accountPublicKey: accountId ?? undefined,
      privateDataPermission: request.privateDataPermission ?? PrivateDataPermission.UponRequest
    });
  }

  return (
    <motion.div
      key="dapp-confirmation-overlay"
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{
        background: 'rgba(0,0,0,0.5)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)'
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dapp-confirmation-title"
    >
      <motion.div
        ref={containerRef}
        className="w-full max-w-[360px] overflow-hidden rounded-2xl bg-pure-white shadow-2xl"
        initial={{ scale: 0.96, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 20 }}
        transition={springs.sheetPresent}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-grey-100 px-6 py-5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-100">
            <Icon name={IconName.Globe} className="text-primary-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="dapp-confirmation-title" className="truncate text-lg font-semibold text-grey-900">
              {appName}
            </h2>
            <p className="truncate text-sm text-grey-500">{request.origin}</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <p className="mb-4 text-sm text-grey-700">
            {isTransaction ? t('dappTransactionRequest') : t('dappConnectionRequest')}
          </p>

          {isTransaction && transactionMessages.length > 0 && (
            <div className="mb-4 rounded-xl bg-grey-50 p-4">
              {transactionMessages.map((msg, i) => (
                <div
                  key={i}
                  className="border-b border-grey-200 py-1 text-xs text-grey-700 last:border-b-0 last:pb-0 first:pt-0"
                >
                  {msg}
                </div>
              ))}
            </div>
          )}

          {!isTransaction && (
            <div className="mb-4 rounded-xl bg-grey-50 p-4">
              <p className="mb-1 text-xs text-grey-500">{t('account')}</p>
              <p className="font-mono text-sm text-grey-900">{accountId || t('noAccountSelected')}</p>
            </div>
          )}

          <div className="rounded-xl bg-grey-50 p-4">
            <p className="mb-1 text-xs text-grey-500">{t('network')}</p>
            <p className="text-sm capitalize text-grey-900">{request.network}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 border-t border-grey-100 px-6 py-5">
          <button
            type="button"
            onClick={handleDeny}
            className="flex-1 rounded-full border-2 border-orange-500 bg-pure-white px-6 py-3 text-sm font-semibold text-orange-500 hover:bg-orange-50"
          >
            {t('deny')}
          </button>
          <button
            ref={approveButtonRef}
            type="button"
            onClick={handleApprove}
            disabled={!canApprove}
            className="flex-1 rounded-full bg-primary-500 px-6 py-3 text-sm font-semibold text-pure-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:bg-primary-200"
          >
            {isTransaction ? t('confirm') : t('approve')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};
