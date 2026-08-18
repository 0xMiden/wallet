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

import React, { type FC, useEffect, useRef, useState } from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { useSprings } from 'lib/animation';
import {
  confirmationPromptKey,
  isDetailsConfirmation,
  type DAppConfirmationRequest,
  type DAppConfirmationResult
} from 'lib/dapp-browser/confirmation-store';
import { formatAllowedPrivateData, grantsStandingPrivateDataAccess } from 'lib/dapp-browser/private-data-scope';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { truncateAddress } from 'utils/string';

interface DappConfirmationModalProps {
  request: DAppConfirmationRequest;
  /** Full bech32 account id — sent back to the dApp on approve and
   *  truncated locally for the connection-panel display. */
  accountId: string | null;
  /** Called when the user approves or denies. The store updates inside this callback. */
  onResolve: (result: DAppConfirmationResult) => void;
}

export const DappConfirmationModal: FC<DappConfirmationModalProps> = ({ request, accountId, onResolve }) => {
  const { t } = useTranslation();
  // PR-7: reduce-motion-aware springs.
  const springs = useSprings();
  // Every non-connect request kind (transaction, consume, sign, importPrivateNote,
  // privateData) renders the same detail-list body; only the prompt line differs.
  const isTransaction = isDetailsConfirmation(request.type);
  const appName = request.appMeta?.name || request.origin;
  const transactionMessages = request.transactionMessages ?? [];
  const canApprove = isTransaction || Boolean(accountId);

  // Private-data scope of a connect request. `Auto` + a non-empty
  // `allowedPrivateData` is STANDING access: the private-notes /
  // consumable-notes / assets handlers then serve the origin on demand with no
  // further prompt, for as long as the session lives. The prompt used to render
  // none of this and echoed the dApp's requested permission straight back, so
  // the user approved a scope they were never shown.
  const requestsStandingPrivateData = grantsStandingPrivateDataAccess(
    request.privateDataPermission,
    request.allowedPrivateData
  );
  const allowedPrivateDataList = formatAllowedPrivateData(request.allowedPrivateData);
  const [standingAccessAcknowledged, setStandingAccessAcknowledged] = useState(false);

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
      // Standing access is granted only on an explicit affirmative gesture.
      // Approving without ticking the box downgrades to `UponRequest` (each
      // read prompts) instead of silently honouring what the dApp asked for.
      privateDataPermission:
        requestsStandingPrivateData && !standingAccessAcknowledged
          ? PrivateDataPermission.UponRequest
          : (request.privateDataPermission ?? PrivateDataPermission.UponRequest),
      // Mobile has no confirm-popup equivalent of ConfirmPage, which reads this
      // for the extension; without it the backend hard-coded delegated proving
      // and silently overrode the user's Delegated-proving setting.
      delegate: isDelegateProofEnabled()
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
        className="w-full max-w-[360px] overflow-hidden rounded-2xl bg-surface-solid shadow-2xl"
        initial={{ scale: 0.96, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 20 }}
        transition={springs.sheetPresent}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border-light px-6 py-5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-100">
            <Icon name={IconName.Globe} className="text-primary-600" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="dapp-confirmation-title" className="truncate text-lg font-semibold text-black">
              {appName}
            </h2>
            <p className="truncate text-sm text-text-muted">{request.origin}</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <p className="mb-4 text-sm text-text-muted">{t(confirmationPromptKey(request.type))}</p>

          {isTransaction && transactionMessages.length > 0 && (
            <div className="mb-4 rounded-xl bg-gray-50 p-4">
              {transactionMessages.map((msg, i) => (
                <div
                  key={i}
                  className="border-b border-border-light py-1 text-xs text-text-muted last:border-b-0 last:pb-0 first:pt-0"
                >
                  {msg}
                </div>
              ))}
            </div>
          )}

          {!isTransaction && (
            <div className="mb-4 rounded-xl bg-grey-50 p-4">
              <p className="mb-1 text-xs text-grey-500">{t('account')}</p>
              <p className="font-inter text-sm text-grey-900">
                {accountId ? truncateAddress(accountId) : t('noAccountSelected')}
              </p>
            </div>
          )}

          {request.type === 'connect' && (
            <div className="mb-4 rounded-xl bg-grey-50 p-4" data-testid="private-data-scope">
              <p className="text-sm font-semibold text-grey-900">
                {requestsStandingPrivateData ? t('privateDataAccessAuto') : t('privateDataAccessUponRequest')}
              </p>
              {requestsStandingPrivateData ? (
                <>
                  <p className="mt-1 text-xs text-grey-500">{t('accessWillBeGranted')}</p>
                  <p className="text-xs font-semibold text-grey-900">{allowedPrivateDataList}</p>
                  <p className="mt-2 text-xs text-grey-500">{t('confirmPrivateDataPermissionDescription')}</p>
                  <label
                    className="mt-3 flex items-start gap-2 text-xs text-grey-900"
                    htmlFor="dapp-standing-private-data"
                  >
                    <input
                      id="dapp-standing-private-data"
                      type="checkbox"
                      checked={standingAccessAcknowledged}
                      onChange={event => setStandingAccessAcknowledged(event.target.checked)}
                    />
                    <span>{t('confirmRisk')}</span>
                  </label>
                </>
              ) : (
                <p className="mt-1 text-xs text-grey-500">{t('confirmationRequired')}</p>
              )}
            </div>
          )}

          <div className="rounded-xl bg-gray-50 p-4">
            <p className="mb-1 text-xs text-text-muted">{t('network')}</p>
            <p className="text-sm capitalize text-black">{request.network}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 border-t border-border-light px-6 py-5">
          <button
            type="button"
            onClick={handleDeny}
            className="flex-1 rounded-full border-2 border-orange-500 bg-surface-solid px-6 py-3 text-sm font-semibold text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/10"
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
