/* eslint-disable no-restricted-globals */

import React, { FC, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SigningInputs, SigningInputsType, Word } from '@miden-sdk/miden-sdk/lazy';
import { PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import ErrorBoundary from 'app/ErrorBoundary';
import { useApprovalPrompt } from 'app/hooks/useDappApprovalTelemetry';
import ContentContainer from 'app/layouts/ContentContainer';
import Unlock, { useRetireLockoutOnReady } from 'app/pages/Unlock';
import { Button, ButtonVariant } from 'components/Button';
import { DappNetworkMismatchNotice } from 'components/DappNetworkMismatchNotice';
import { NetworkModeBanner } from 'components/NetworkModeBanner';
import { SpendingLimitChallenge } from 'components/SpendingLimitChallenge';
import { OriginatorChip } from 'components/tx-stage/OriginatorChip';
import { storyFromMessages } from 'components/tx-stage/tx-story';
import { TxStory } from 'components/tx-stage/TxStory';
import { CopyButton } from 'components/ui/CopyButton';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Spinner } from 'components/ui/Spinner';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { parseSerializedSpendingLimitAssessment } from 'lib/miden/spending-limits/types';
import { MidenDAppPayload } from 'lib/miden/types';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { b64ToU8 } from 'lib/shared/helpers';
import { WalletAccount } from 'lib/shared/types';
import { useRetryableSWR } from 'lib/swr';
import { annotateCrash } from 'lib/telemetry/crash-diagnostics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error';
import useSafeState from 'lib/ui/useSafeState';
import { useLocation } from 'lib/woozie';
import { truncateAddress, truncateHash } from 'utils/string';

import Alert from './atoms/Alert';
import { AdvancedDetails, FoldableField } from './confirm/AdvancedDetails';
import { declaredRequestToView, simulatedBytesToView, summaryToView, TxAssetView } from './confirm/decode';
import { noteFlowFromSimulatedBytes, noteFlowFromTransaction, NoteFlow } from './confirm/note-flow';
import { TransactionAssetView } from './confirm/TransactionAssetView';
import { ConfirmPageSelectors } from './ConfirmPage.selectors';
import { ReactComponent as BreadLogo } from './icons/brand/new-bread.svg';
import { Icon, IconName } from './icons/v2';
import AccountBanner from './templates/AccountBanner';
import ConnectBanner from './templates/ConnectBanner';
import PrivateDataPermissionBanner from './templates/PrivateDataPermissionBanner';
import PrivateDataPermissionCheckbox from './templates/PrivateDataPermissionCheckbox';

const ConfirmPage: FC = () => {
  const { t } = useTranslation();
  const { ready } = useMidenContext();
  // This window renders its own Unlock and never mounts PageRouter, so it retires the record itself.
  useRetireLockoutOnReady(ready);

  const page = useMemo(
    () =>
      ready ? (
        <ContentContainer padding={false} className="flex flex-col items-center justify-center bg-app-bg">
          <ErrorBoundary whileMessage={t('fetchingConfirmationDetails')}>
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center bg-app-bg">
                  <div>
                    <Spinner />
                  </div>
                </div>
              }
            >
              <ConfirmDAppForm />
            </Suspense>
          </ErrorBoundary>
        </ContentContainer>
      ) : (
        <Unlock openForgotPasswordInFullPage={true} />
      ),
    [ready, t]
  );

  // The network banner (#875) tops the confirm window the way PageRouter tops
  // every routed page, and dapp.ts sizes the popup for it (CONFIRM_WINDOW_HEIGHT).
  return (
    <div className="flex min-h-screen flex-col bg-app-bg">
      <NetworkModeBanner />
      {page}
    </div>
  );
};

function downloadData(filename: string, data: string) {
  const blob = new Blob([data], { type: 'application/json' });
  const link = document.createElement('a');

  link.href = URL.createObjectURL(blob);
  link.download = filename;

  document.body.appendChild(link);

  link.click();

  document.body.removeChild(link);
}

function downloadBytes(filename: string, data: Uint8Array, mimeType = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeType });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);

  try {
    a.click();
  } finally {
    a.remove();
    // Give the browser a microtask to start the download before revoking
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const SignatureRawValue: FC<{ value: string; errorId?: UserErrorId | null }> = ({ value, errorId }) => {
  useUserVisibleError(errorId, 'inline');
  return <>{value}</>;
};

const OpaqueSignatureWarning: React.FC<{ rawValue: string; errorId?: UserErrorId | null }> = ({
  rawValue,
  errorId
}) => {
  const { t } = useTranslation();
  return (
    <>
      <Alert type="warn" title={t('opaqueSignatureTitle')} description={t('opaqueSignatureWarning')} className="my-2" />
      <AdvancedDetails label={t('rawValue')}>
        <SignatureRawValue value={rawValue} errorId={errorId} />
      </AdvancedDetails>
    </>
  );
};

/** The sentence under the originator chip: what this site is asking for. */
const RequestOriginBanner: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className={classNames(
      'text-sm text-left text-ink',
      'tx-stage-rise flex w-full gap-x-3 items-center p-4',
      'border border-gray-100 rounded-2xl mb-4'
    )}
  >
    <Icon name={IconName.Globe} fill="currentColor" size="md" className="shrink-0" />
    <div className="flex min-w-0 flex-col">{children}</div>
  </div>
);

/**
 * E2E hook for one `label, value` row of a transaction/consume approval screen.
 * The labels are raw dApp-preview keys ("Amount", "Recipient", "Note Type"), so
 * they're slugified rather than used verbatim.
 */
const txRowValueTestId = (label: string | undefined) =>
  `confirm-tx-value-${(label ?? '').trim().toLowerCase().replace(/\s+/g, '-')}`;

interface PayloadContentProps {
  payload: MidenDAppPayload;
  account?: WalletAccount;
  viewKey?: string;
  error?: any;
}

const PayloadContent: React.FC<PayloadContentProps> = ({ payload, error, account, viewKey }) => {
  const { t } = useTranslation();
  let content: string | React.ReactNode = t('noPreview');

  switch (payload.type) {
    case 'sign': {
      const bytes = b64ToU8(payload.payload);

      switch (payload.kind) {
        case 'word': {
          let wordHex = t('invalidPayload');
          let wordErrorId: UserErrorId | null = null;
          try {
            const word = Word.deserialize(bytes);
            wordHex = word.toHex();
          } catch (e) {
            wordErrorId = 'invalidPayload';
            console.error('Failed to deserialize payload for sign:', e);
          }
          content = <OpaqueSignatureWarning rawValue={wordHex} errorId={wordErrorId} />;
          break;
        }

        case 'signingInputs': {
          console.log('Signing inputs payload', bytes);
          content = <SigningInputsPayloadContent bytes={bytes} />;
          break;
        }
      }

      break;
    }

    // The login key signs only sign-ins to its own site, so a login shows no opaque-signature warning.
    case 'loginSign':
      content = (
        <>
          <p className="my-2 text-body-sm text-ink">{t('loginSignatureNote', { domain: payload.domain })}</p>
          <DetailCard className="my-2">
            <DetailRow label={t('account')} stacked data-testid="confirm-login-account">
              <span className="min-w-0 font-sans font-semibold">{payload.accountId}</span>
              <CopyButton text={payload.accountId} data-testid="confirm-login-account-copy" />
            </DetailRow>
          </DetailCard>
        </>
      );
      break;

    case 'privateNotes': {
      content = (
        <>
          <div className="text-md text-center my-6">
            {t('sharePrivateNoteDataForAccount')}
            <br />
            {`${truncateAddress(payload.sourcePublicKey)}?`}
          </div>
          <div className="flex items-center justify-center">
            <Button
              type="button"
              variant={ButtonVariant.Secondary}
              size="sm"
              className="w-3/5"
              onClick={() => downloadData('privateNotes.json', JSON.stringify(payload.privateNotes, null, 2))}
            >
              {t('downloadPrivateNoteData')}
            </Button>
          </div>
        </>
      );
      break;
    }

    case 'transaction': {
      if (payload.txKind === 'custom') {
        content = <CustomTransactionContent payload={payload} id={viewKey ?? ''} />;
        break;
      }
      content = (
        <div>
          <div className="tx-stage-rise text-sm" key={0}>
            {payload.transactionMessages[0]} <br />
            <span data-testid="confirm-tx-faucet">{payload.transactionMessages[1]}</span>
          </div>
          <TxStory hops={storyFromMessages(payload.transactionMessages, { skip: 2 })} />
          {account && (
            <>
              <hr className="h-px bg-border-light my-4" />
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">{t('account')}</span>
                <div className="text-ink flex flex-col items-end">
                  <span>{account.name}</span>
                  <span>{truncateAddress(account.publicKey)}</span>
                </div>
              </div>
            </>
          )}
          <hr className="h-px bg-border-light my-4" />
          <div className="tx-stage-list">
            {payload.transactionMessages.slice(2).map((message, i) => {
              const [label, rawValue] = message.split(', ');
              // Amount arrives already formatted from the faucet's real decimals
              // (dapp.ts `formatSendTransactionPreview`) — do NOT re-scale it here.
              // Dividing by a hardcoded 10**6 mis-rendered every non-6-decimal
              // token and lost precision above 2^53 via `Number()`.
              let value = rawValue ?? '';
              if (label === 'Recipient') {
                value = truncateAddress(value);
              }
              return (
                <div className="flex justify-between my-2 text-sm" key={i + 2}>
                  <span className="text-text-muted">{label}</span>
                  <span className="text-ink" data-testid={txRowValueTestId(label)}>
                    {value}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      );
      break;
    }

    case 'consume':
      content = (
        <div>
          <div className="tx-stage-rise text-sm" key={0}>
            {payload.transactionMessages[0]}
          </div>
          <TxStory hops={storyFromMessages(payload.transactionMessages, { skip: 1, incoming: true })} />
          {account && (
            <>
              <hr className="h-px bg-border-light my-4" />
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">{t('account')}</span>
                <div className="text-ink flex flex-col items-end">
                  <span>{account.name}</span>
                  <span>{truncateAddress(account.publicKey)}</span>
                </div>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">{t('noteId')}</span>
                <div className="text-ink flex flex-col items-end">
                  <span>{truncateHash(payload.noteId)}</span>
                </div>
              </div>
            </>
          )}
          <hr className="h-px bg-border-light my-4" />
          <div className="tx-stage-list">
            {payload.transactionMessages.slice(1).map((message, i) => {
              const [label, rawValue] = message.split(', ');
              let value = rawValue ?? '';
              if (label === 'Recipient') {
                value = truncateAddress(value);
              }
              return (
                <div className="flex justify-between my-2 text-sm" key={i + 2}>
                  <span className="text-text-muted">{label}</span>
                  <span className="text-ink" data-testid={txRowValueTestId(label)}>
                    {value}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      );
      break;
  }

  useUserVisibleError(error ? 'raw_confirm_payload_failed' : null, 'inline');

  return (
    <div className={classNames('w-full', 'flex flex-col')}>
      {/* A login shows the note and the signing account, never a payload, so it gets no payload heading. */}
      {payload.type !== 'loginSign' && t('payload') && (
        <h2 className={classNames('mb-2', 'leading-tight', 'flex flex-col')}>
          <span className="text-ink font-medium" style={{ fontSize: '14px', lineHeight: '20px' }}>
            {t('payload')}
          </span>
        </h2>
      )}
      <div className="text-sm text-ink">{error ? error : content}</div>
    </div>
  );
};

const SigningInputsPayloadContent: React.FC<{ bytes: Uint8Array }> = ({ bytes }) => {
  const { t } = useTranslation();

  const signingInputs = useMemo(() => {
    try {
      return SigningInputs.deserialize(bytes);
    } catch (e) {
      console.error('Failed to deserialize payload for sign:', e);
      return null;
    }
  }, [bytes]);

  useUserVisibleError(signingInputs ? null : 'failedToParseSigningPayload', 'inline');

  if (!signingInputs) {
    return <div className="text-md text-center my-6">{t('failedToParseSigningPayload')}</div>;
  }

  switch (signingInputs.variantType) {
    case SigningInputsType.TransactionSummary: {
      const summary = signingInputs.transactionSummaryPayload();
      let noteFlow: NoteFlow | undefined;
      try {
        noteFlow = noteFlowFromTransaction(summary);
      } catch (noteError) {
        console.error('Signing summary note details unavailable:', noteError);
      }
      return (
        <TransactionAssetView
          view={summaryToView(summary)}
          noteFlow={noteFlow}
          mode="verified"
          onDownload={() => downloadBytes('transaction_summary.bin', bytes)}
        />
      );
    }
    case SigningInputsType.Arbitrary:
    case SigningInputsType.Blind:
      return (
        <OpaqueSignatureWarning
          rawValue={
            signingInputs.variantType === SigningInputsType.Arbitrary
              ? t('signArbitraryPayload')
              : t('signBlindCommitment')
          }
        />
      );
    default:
      return <div className="text-md text-center my-6">{t('noPreview')}</div>;
  }
};

const CustomTransactionContent: React.FC<{
  payload: Extract<MidenDAppPayload, { type: 'transaction' }>;
  id: string;
}> = ({ payload, id }) => {
  const { t } = useTranslation();
  const { simulateCustomTransaction } = useMidenContext();

  const declaredView = useMemo<TxAssetView | null>(() => {
    if (!payload.requestBytes) return null;
    try {
      return declaredRequestToView(payload.requestBytes, payload.importNotes ?? []);
    } catch (e) {
      console.error('Failed to decode declared custom transaction:', e);
      return null;
    }
  }, [payload.requestBytes, payload.importNotes]);

  const [verifiedView, setVerifiedView] = useState<TxAssetView | null>(null);
  const [verifiedNoteFlow, setVerifiedNoteFlow] = useState<NoteFlow>();
  const [simError, setSimError] = useState(false);
  useUserVisibleError(
    verifiedView ? null : declaredView ? (simError ? 'couldNotVerifyBySimulation' : null) : 'couldNotDecodeTransaction',
    'inline'
  );

  useEffect(() => {
    if (!payload.requestBytes) return;
    let cancelled = false;
    (async () => {
      try {
        const { summaryBytes, executedBytes } = await simulateCustomTransaction(id);
        if (cancelled) return;
        // Summary when authorization is still pending, executed transaction for every ordinary
        // single-sig account on web-sdk 0.16 - same ground truth either way. The choice lives in
        // `simulatedBytesToView` so the backend's spending-limit gate decodes it identically;
        // a second copy of this ladder there once treated every ordinary account as unsimulatable.
        const view = simulatedBytesToView({ summaryBytes, executedBytes });
        if (view) {
          setVerifiedView(view);
          try {
            setVerifiedNoteFlow(noteFlowFromSimulatedBytes({ summaryBytes, executedBytes }));
          } catch (noteError) {
            console.error('Custom transaction note details unavailable:', noteError);
            setVerifiedNoteFlow(undefined);
          }
          return;
        }
        setSimError(true);
      } catch (e) {
        console.error('Custom transaction simulation failed:', e);
        if (!cancelled) setSimError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, payload.requestBytes, simulateCustomTransaction]);

  const advanced = (
    <AdvancedDetails label={t('rawTransactionData')}>
      {/* These labels are intentional raw payload-field keys (a JSON-like dump
          of the dApp-declared request), not user-facing copy — deliberately
          not translated via t(). */}
      {/* eslint-disable i18next/no-literal-string -- raw dApp payload-field keys, not user-facing copy */}
      <FoldableField label="recipient" value={payload.recipientAddress ?? '(none)'} />
      <FoldableField label="importNotes" value={payload.importNotes?.length ?? 0} />
      <FoldableField label="requestBytes" value={payload.requestBytes ?? '(none)'} />
      {/* eslint-enable i18next/no-literal-string */}
    </AdvancedDetails>
  );

  if (verifiedView) {
    return (
      <>
        <TransactionAssetView view={verifiedView} mode="verified" noteFlow={verifiedNoteFlow} />
        {advanced}
      </>
    );
  }

  if (declaredView) {
    return (
      <>
        <TransactionAssetView view={declaredView} mode="declared" />
        {simError && (
          <div className="text-xs text-text-muted my-2" data-testid="tx-simulation-failed">
            {t('couldNotVerifyBySimulation')}
          </div>
        )}
        {advanced}
      </>
    );
  }

  return (
    <div>
      <div className="text-sm my-4">{t('couldNotDecodeTransaction')}</div>
      {advanced}
    </div>
  );
};

export default ConfirmPage;

const ConfirmDAppForm: FC = () => {
  const { t } = useTranslation();
  const {
    getDAppPayload,
    confirmDAppPermission,
    confirmDAppTransaction,
    confirmDAppPrivateNotes,
    confirmDAppSign,
    confirmDAppAssets,
    confirmDAppImportPrivateNote,
    confirmDAppConsumableNotes,
    confirmDAppUnlock
  } = useMidenContext();
  const account = useAccount();
  const isPublicAccount = account.isPublic;

  const loc = useLocation();
  const id = useMemo(() => {
    const usp = new URLSearchParams(loc.search);
    const pageId = usp.get('id');
    if (!pageId) {
      const error = new Error(t('notIdentified'));
      annotateCrash(error, { operation: 'confirm_payload', confirmationId: pageId === null ? 'missing' : 'empty' });
      throw error;
    }
    return pageId;
  }, [loc.search, t]);

  const { data } = useRetryableSWR<MidenDAppPayload>([id], getDAppPayload, {
    suspense: true,
    shouldRetryOnError: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false
  });
  const payload = data!;
  const payloadError = data!.error;
  const spendingLimitAssessment = useMemo(
    () =>
      payload.type === 'transaction' && payload.spendingLimitAssessment !== undefined
        ? parseSerializedSpendingLimitAssessment(payload.spendingLimitAssessment)
        : undefined,
    [payload]
  );
  let requirePrivateDataCheckbox = false;
  let privateDataPermission = PrivateDataPermission.UponRequest;
  if (payload.type === 'connect') {
    privateDataPermission = payload.privateDataPermission;
  }
  requirePrivateDataCheckbox = privateDataPermission === PrivateDataPermission.Auto && !isPublicAccount;
  const [isPrivateDataChecked, setIsPrivateDataChecked] = useState(false);
  const delegate = isDelegateProofEnabled();
  const [showSpendingLimitChallenge, setShowSpendingLimitChallenge] = useState(false);
  const confirmationInFlightRef = useRef(false);

  const onConfirm = useCallback(
    async (confirmed: boolean, spendingLimitAuthenticated?: true) => {
      switch (payload.type) {
        case 'connect':
          return confirmDAppPermission(
            id,
            confirmed,
            account.publicKey,
            privateDataPermission,
            payload.allowedPrivateData
          );
        case 'transaction':
        case 'consume':
          if (spendingLimitAuthenticated === true) {
            await confirmDAppTransaction(id, confirmed, delegate, true);
          } else {
            await confirmDAppTransaction(id, confirmed, delegate);
          }
          // No navigation after an approval: this window never mounts PageRouter, so a route change only
          // drops `?id=` and crashes this form while the background closes the window.
          return;
        case 'privateNotes':
          return confirmDAppPrivateNotes(id, confirmed);
        case 'sign':
        case 'loginSign':
          return confirmDAppSign(id, confirmed);
        case 'assets':
          return confirmDAppAssets(id, confirmed);
        case 'importPrivateNote':
          return confirmDAppImportPrivateNote(id, confirmed);
        case 'consumableNotes':
          return confirmDAppConsumableNotes(id, confirmed);
        case 'unlock':
          return confirmDAppUnlock(id);
      }
    },
    [
      id,
      payload,
      confirmDAppPermission,
      account.publicKey,
      privateDataPermission,
      confirmDAppTransaction,
      confirmDAppPrivateNotes,
      confirmDAppSign,
      confirmDAppAssets,
      confirmDAppImportPrivateNote,
      confirmDAppConsumableNotes,
      confirmDAppUnlock,
      delegate
    ]
  );

  const [error, setError] = useSafeState<any>(null);
  const [errorId, setErrorId] = useSafeState<UserErrorId | null>(null);
  const [confirming, setConfirming] = useSafeState(false);
  const [declining, setDeclining] = useSafeState(false);

  // The extension's approval telemetry. The confirmation store the other
  // platforms report from is unreachable here — see `useApprovalPrompt`.
  //
  // Suppressed for the auto-approved reconnect answered below, where the user is
  // shown nothing and asked nothing, so there is no approval to measure.
  // An unlock-only request (#1414) asks nothing either.
  const autoApproved = payload.type === 'unlock' || (payload.type === 'connect' && Boolean(payload.existingPermission));
  const settleApproval = useApprovalPrompt(payload.type, !autoApproved);

  const confirm = useCallback(
    async (confirmed: boolean, spendingLimitAuthenticated?: true) => {
      setError(null);
      try {
        // An existing permission's consent was given when its session was saved, so its answer and Retry skip the box.
        if (confirmed && requirePrivateDataCheckbox && !isPrivateDataChecked && !autoApproved) {
          setErrorId('confirmError');
          throw new Error(t('confirmError'));
        }
        await onConfirm(confirmed, spendingLimitAuthenticated);
        // Settled only once the decision has actually been delivered: the
        // private-data check above throws before that and the user is still
        // being asked, so the flow stays open for their next attempt.
        settleApproval(confirmed);
      } catch (err: any) {
        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError(err);
        if (!confirmed || !requirePrivateDataCheckbox || isPrivateDataChecked || autoApproved) {
          setErrorId(err?.message == null ? 'smthWentWrong' : 'raw_confirm_approval_failed');
        }
      }
    },
    [onConfirm, setError, setErrorId, requirePrivateDataCheckbox, isPrivateDataChecked, autoApproved, settleApproval, t]
  );

  // An unlock-only request has nothing to approve: once the user has unlocked, answer it.
  const unlockAnsweredRef = useRef(false);
  useEffect(() => {
    if (payload.type !== 'unlock' || unlockAnsweredRef.current) return;
    unlockAnsweredRef.current = true;
    void confirm(true);
  }, [payload.type, confirm]);

  // An existing permission is answered once, unasked, through `confirm` like its Retry (#1471).
  const existingPermissionAnsweredRef = useRef(false);
  useEffect(() => {
    if (payload.type !== 'connect' || !payload.existingPermission || existingPermissionAnsweredRef.current) return;
    existingPermissionAnsweredRef.current = true;
    void confirm(true);
  }, [payload, confirm]);

  const handleConfirmClick = useCallback(async () => {
    if (confirming || declining || confirmationInFlightRef.current) return;
    if (spendingLimitAssessment !== undefined) {
      setShowSpendingLimitChallenge(true);
      return;
    }

    confirmationInFlightRef.current = true;
    setConfirming(true);
    await confirm(true);
    setConfirming(false);
    confirmationInFlightRef.current = false;
  }, [confirming, declining, setConfirming, confirm, spendingLimitAssessment]);

  const handleDeclineClick = useCallback(async () => {
    if (confirming || declining) return;

    setDeclining(true);
    await confirm(false);
    setDeclining(false);
  }, [confirming, declining, setDeclining, confirm]);

  const handleErrorAlertClose = useCallback(() => setError(null), [setError]);

  const content = useMemo(() => {
    switch (payload.type) {
      case 'connect':
        return {
          title: t('connectToWebsite'),
          declineActionTitle: t('deny'),
          declineActionTestID: ConfirmPageSelectors.ConnectAction_CancelButton,
          confirmActionTitle: error ? t('retry') : t('connect'),
          confirmActionTestID: error
            ? ConfirmPageSelectors.ConnectAction_RetryButton
            : ConfirmPageSelectors.ConnectAction_ConnectButton,
          want: (
            <PrivateDataPermissionBanner
              privateDataPermission={privateDataPermission}
              allowedPrivateData={payload.allowedPrivateData}
              isPublicAccount={isPublicAccount}
            />
          )
        };
      case 'transaction':
        return {
          title: t('confirmAction', { action: t('transactionAction') }),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.TransactionAction_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.TransactionAction_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span>{t('requestsATransaction')}</span>
            </RequestOriginBanner>
          )
        };
      case 'consume':
        return {
          title: t('confirmAction', { action: t('transactionAction') }),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.ConsumeAction_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.ConsumeAction_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span>{t('requestsToConsumeNote')}</span>
            </RequestOriginBanner>
          )
        };
      case 'privateNotes':
        return {
          title: t('requestPrivateNotes'),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.RequestPrivateNotes_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.RequestPrivateNotes_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span>{t('requestsPrivateNotes')}</span>
            </RequestOriginBanner>
          )
        };
      case 'sign':
        return {
          title: t('confirmSignature'),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.SignData_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.SignData_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span className="text-text-muted">{t('requestsYourSignature')}</span>
            </RequestOriginBanner>
          )
        };
      case 'loginSign':
        return {
          title: t('confirmLoginSignature', { domain: payload.domain }),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.LoginSign_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.LoginSign_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span className="text-muted">{t('requestsYourSignature')}</span>
            </RequestOriginBanner>
          )
        };
      case 'assets':
        return {
          title: t('requestAssets'),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.RequestAssets_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.RequestAssets_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span>{t('requestsAssets')}</span>
            </RequestOriginBanner>
          )
        };
      case 'importPrivateNote':
        return {
          title: t('requestImportPrivateNote'),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.RequestImportPrivateNote_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.RequestImportPrivateNote_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span>{t('importPrivateNote')}</span>
            </RequestOriginBanner>
          )
        };
      case 'consumableNotes':
        return {
          title: t('requestConsumableNotes'),
          declineActionTitle: t('cancel'),
          declineActionTestID: ConfirmPageSelectors.RequestConsumableNotes_RejectButton,
          confirmActionTitle: t('confirm'),
          confirmActionTestID: ConfirmPageSelectors.RequestConsumableNotes_AcceptButton,
          want: (
            <RequestOriginBanner>
              <span>{t('requestsConsumableNotes')}</span>
            </RequestOriginBanner>
          )
        };
      case 'unlock':
        return null;
    }
  }, [error, payload, privateDataPermission, isPublicAccount, t]);

  if (content === null) {
    return (
      <div className="flex flex-1 items-center justify-center bg-app-bg">
        <Spinner />
      </div>
    );
  }

  return (
    <div
      className={classNames(
        'tx-stage-popup relative bg-surface-solid text-ink rounded-md shadow-md overflow-y-auto',
        'flex flex-col'
      )}
      style={{
        width: 440,
        minHeight: 694
      }}
    >
      <div className="flex flex-col items-left px-4">
        <div className="flex items-center gap-3 pt-6 pb-3">
          <BreadLogo className="shrink-0" style={{ width: 28, height: 'auto' }} aria-label={t('appName')} />
          <h2 className="flex min-w-0 text-ink text-lg font-semibold">{content.title}</h2>
        </div>
        <div className="tx-stage-rule mb-4" aria-hidden="true" />

        {payload.type !== 'connect' && (
          <div className="mb-4">
            <OriginatorChip origin={payload.origin} testId="confirm-request-origin" />
          </div>
        )}

        {payload.type === 'connect' && (
          <ConnectBanner type={payload.type} origin={payload.origin} appMeta={payload.appMeta} />
        )}

        {content.want}

        {error ? (
          <Alert
            closable
            onClose={handleErrorAlertClose}
            type="error"
            errorId={errorId}
            title={t('error')}
            description={error?.message ?? t('smthWentWrong')}
            className="my-4"
            autoFocus
          />
        ) : (
          <>
            {payload.type === 'connect' ? (
              <>
                {account && (
                  <AccountBanner
                    account={account}
                    networkRpc={payload.networkRpc}
                    labelIndent="sm"
                    className="w-full my-2"
                  />
                )}
                <DappNetworkMismatchNotice claimedNetwork={payload.network} className="my-2" />
              </>
            ) : (
              <PayloadContent payload={payload} error={payloadError} account={account} viewKey={id} />
            )}
          </>
        )}

        {requirePrivateDataCheckbox && <PrivateDataPermissionCheckbox setChecked={setIsPrivateDataChecked} />}
      </div>

      <div className="flex-1" />

      <div
        className={classNames(
          'sticky bottom-0 w-full',
          'bg-surface-solid shadow-md',
          'flex items-stretch',
          'px-4 pt-2 pb-6'
        )}
      >
        <div className="w-1/2 pr-2">
          <Button
            type="button"
            variant={ButtonVariant.Secondary}
            className="w-full"
            isLoading={declining}
            onClick={handleDeclineClick}
            data-testid={content.declineActionTestID}
          >
            {content.declineActionTitle}
          </Button>
        </div>

        <div className="tx-stage-cta w-1/2 pl-2">
          <Button
            type="button"
            variant={ButtonVariant.Primary}
            className="w-full"
            isLoading={confirming}
            onClick={handleConfirmClick}
            data-testid={content.confirmActionTestID}
          >
            {content.confirmActionTitle}
          </Button>
        </div>
      </div>
      {showSpendingLimitChallenge && spendingLimitAssessment !== undefined && (
        <SpendingLimitChallenge
          assessment={spendingLimitAssessment}
          onResult={authorization => {
            setShowSpendingLimitChallenge(false);
            if (confirmationInFlightRef.current) return;
            confirmationInFlightRef.current = true;
            setConfirming(true);
            void confirm(authorization !== undefined, authorization === undefined ? undefined : true).finally(() => {
              setConfirming(false);
              confirmationInFlightRef.current = false;
            });
          }}
        />
      )}
    </div>
  );
};
