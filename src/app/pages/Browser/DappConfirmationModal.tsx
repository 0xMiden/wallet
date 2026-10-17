import React, { type FC, useEffect, useRef, useState } from 'react';

import { PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import * as Dialog from '@radix-ui/react-dialog';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { DappNetworkMismatchNotice } from 'components/DappNetworkMismatchNotice';
import { SpendingLimitChallenge } from 'components/SpendingLimitChallenge';
import { DappOrigin } from 'components/ui/DappOrigin';
import { ErrorLine } from 'components/ui/ErrorLine';
import { useSprings } from 'lib/animation';
import { confirmSensitiveAction } from 'lib/biometric';
import {
  confirmationPromptKey,
  isDetailsConfirmation,
  type DAppConfirmationRequest,
  type DAppConfirmationResult
} from 'lib/dapp-browser/confirmation-store';
import { formatAllowedPrivateData, grantsStandingPrivateDataAccess } from 'lib/dapp-browser/private-data-scope';
import { probeHardwareProtector } from 'lib/miden/back/protector-probe';
import { sameWalletAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { HOST_MODAL_LAYER, useImperativeModalFocus } from 'lib/ui/host-modal';
import { truncateAddress } from 'utils/string';

interface DappConfirmationModalProps {
  request: DAppConfirmationRequest;
  /** Full bech32 account id — sent back to the dApp on approve and
   *  truncated locally for the connection-panel display. */
  accountId: string | null;
  /** Called with the id of the request the user approved or denied. The store updates inside this callback. */
  onResolve: (result: DAppConfirmationResult, requestId: string) => void;
}

export const DappConfirmationModal: FC<DappConfirmationModalProps> = ({ request, accountId, onResolve }) => {
  const { t } = useTranslation();
  // PR-7: reduce-motion-aware springs.
  const springs = useSprings();
  // Every non-connect request kind (transaction, consume, sign, importPrivateNote,
  // privateData) renders the same detail-list body; only the prompt line differs.
  const isTransaction = isDetailsConfirmation(request.type);
  const transactionMessages = request.transactionMessages ?? [];
  const transactionAccountMatches =
    request.type !== 'transaction' ||
    (accountId !== null &&
      request.sourcePublicKey !== undefined &&
      sameWalletAccountId(accountId, request.sourcePublicKey));
  const canApprove = request.type === 'transaction' ? transactionAccountMatches : isTransaction || Boolean(accountId);

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
  const [showSpendingLimitChallenge, setShowSpendingLimitChallenge] = useState(false);
  // Kept with the request whose prompt failed and shown only while that request is on screen, so a
  // rejection that lands after a replacement never reads as the new request's failure.
  const [approvalError, setApprovalError] = useState<{ requestId: string; message: string } | null>(null);
  const previousAttemptError =
    request.previousAttemptError === undefined ? undefined : request.previousAttemptError || t('smthWentWrong');
  const shownError = approvalError?.requestId === request.id ? approvalError.message : previousAttemptError;
  const resolvedRef = useRef(false);
  // A declined or failed prompt must leave Approve tappable again, so this is its own
  // latch rather than folded into `resolvedRef`, which marks a request as settled for good.
  const pendingApprovalRef = useRef(false);
  // The id of the request this mounted modal currently shows. `requestConfirmation`
  // replaces a still-pending entry for the same session before this component's
  // props catch up, so a confirm awaited for an earlier request must not resolve
  // whatever request now sits at that slot - null once unmounted.
  const currentRequestIdRef = useRef<string | null>(request.id);

  const containerRef = useRef<HTMLDivElement>(null);
  const focus = useImperativeModalFocus();
  const approveButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    resolvedRef.current = false;
    pendingApprovalRef.current = false;
    currentRequestIdRef.current = request.id;
    setShowSpendingLimitChallenge(false);
    setApprovalError(null);
    setStandingAccessAcknowledged(false);
    return () => {
      currentRequestIdRef.current = null;
    };
  }, [request.id]);

  useEffect(() => {
    if (request.type !== 'transaction' || transactionAccountMatches || resolvedRef.current) return;
    resolvedRef.current = true;
    onResolve({ confirmed: false }, request.id);
  }, [onResolve, request.id, request.type, transactionAccountMatches]);

  // Escape and the back handler register once, so they deny through this to reach the request on screen now.
  const handleDenyRef = useRef(handleDeny);
  handleDenyRef.current = handleDeny;

  // Hardware back / iOS swipe-back closes the modal as a deny.
  useMobileBackHandler(
    () => {
      handleDenyRef.current();
      return true;
    },
    [],
    { overlay: true }
  );

  function handleDeny() {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    hapticLight();
    onResolve({ confirmed: false }, request.id);
  }

  function resolveApproval(spendingLimitAuthenticated?: true) {
    if (!canApprove) return;
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    hapticMedium();
    onResolve(
      {
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
        delegate: isDelegateProofEnabled(),
        ...(spendingLimitAuthenticated === true && { spendingLimitAuthenticated: true as const })
      },
      request.id
    );
  }

  async function handleApprove() {
    if (!canApprove || resolvedRef.current || pendingApprovalRef.current) return;
    setApprovalError(null);
    if (request.spendingLimitAssessment !== undefined) {
      setShowSpendingLimitChallenge(true);
      return;
    }
    const requestId = request.id;
    pendingApprovalRef.current = true;
    if (request.type === 'transaction') {
      try {
        const confirmed = await confirmSensitiveAction(t('confirmDappTransactionReason'), probeHardwareProtector);
        // This request may have been superseded (a new one replaced it at the same
        // session slot) or the modal may have unmounted while the prompt was open -
        // either way `currentRequestIdRef` no longer names it, and resolving now
        // would hand this approval to whatever request sits there instead.
        if (currentRequestIdRef.current !== requestId) return;
        if (!confirmed) {
          pendingApprovalRef.current = false;
          return;
        }
      } catch (error) {
        console.error(error);
        if (currentRequestIdRef.current === requestId) {
          pendingApprovalRef.current = false;
          setApprovalError({
            requestId,
            message: error instanceof Error && error.message ? error.message : t('smthWentWrong')
          });
        }
        return;
      }
    }
    resolveApproval();
  }

  const approvalModal = (
    <Dialog.Root open onOpenChange={open => !open && handleDenyRef.current()}>
      <Dialog.Portal>
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onOpenAutoFocus={event => {
            event.preventDefault();
            focus.remember();
            const target =
              approveButtonRef.current && !approveButtonRef.current.disabled
                ? approveButtonRef.current
                : containerRef.current?.querySelector<HTMLElement>(
                    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
                  );
            target?.focus();
          }}
          onCloseAutoFocus={focus.restore}
          onPointerDownOutside={event => event.preventDefault()}
        >
          <motion.div
            key="dapp-confirmation-overlay"
            className={`fixed inset-0 ${HOST_MODAL_LAYER} flex items-center justify-center pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,var(--app-safe-bottom,0px),env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]`}
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
          >
            <motion.div
              ref={containerRef}
              className="flex max-h-full min-h-0 w-full max-w-[360px] flex-col overflow-hidden rounded-2xl bg-surface-solid shadow-2xl"
              initial={{ scale: 0.96, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.96, opacity: 0, y: 20 }}
              transition={springs.sheetPresent}
            >
              {/* Header */}
              <div className="flex shrink-0 items-center gap-3 border-b border-border-light px-6 py-5">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary-100">
                  <Icon name={IconName.Globe} className="text-primary-600" />
                </div>
                <div className="min-w-0 flex-1">
                  {/* The injected providers send only the page's hostname as appMeta.name, so any other name is forged. */}
                  <Dialog.Title asChild>
                    <h2 className="text-lg font-semibold text-ink">
                      <DappOrigin origin={request.origin} data-testid="dapp-confirmation-origin" />
                    </h2>
                  </Dialog.Title>
                </div>
              </div>

              {/* Body */}
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <p className="mb-4 text-sm text-text-muted">{t(confirmationPromptKey(request.type))}</p>

                {isTransaction && transactionMessages.length > 0 && (
                  <div className="mb-4 rounded-xl bg-fill p-4">
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

                <div className="rounded-xl bg-fill p-4">
                  <p className="mb-1 text-xs text-text-muted">{t('network')}</p>
                  {/* Every request runs on the wallet's own network; `request.network` is only the dApp's claim. */}
                  <p className="text-sm text-ink" data-testid="dapp-confirmation-network">
                    {t(getEffectiveNetworkName())}
                  </p>
                </div>

                {request.type === 'connect' && (
                  <DappNetworkMismatchNotice claimedNetwork={request.network} className="mt-3" />
                )}

                {shownError !== undefined && (
                  <ErrorLine data-testid="dapp-approval-error" className="mt-3">
                    {shownError}
                  </ErrorLine>
                )}
              </div>

              {/* Actions */}
              <div className="flex shrink-0 gap-3 border-t border-border-light px-6 py-5">
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
                  {isTransaction ? t('confirm') : previousAttemptError === undefined ? t('approve') : t('retry')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return (
    <>
      {approvalModal}
      {showSpendingLimitChallenge && request.spendingLimitAssessment !== undefined && (
        <SpendingLimitChallenge
          assessment={request.spendingLimitAssessment}
          onResult={authorization => {
            setShowSpendingLimitChallenge(false);
            if (authorization === undefined) {
              handleDeny();
            } else {
              resolveApproval(true);
            }
          }}
        />
      )}
    </>
  );
};
