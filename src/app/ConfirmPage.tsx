/* eslint-disable no-restricted-globals */

import React, { FC, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { SigningInputs, SigningInputsType, Word } from '@miden-sdk/miden-sdk/lazy';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import Spinner from 'app/atoms/Spinner/Spinner';
import ErrorBoundary from 'app/ErrorBoundary';
import ContentContainer from 'app/layouts/ContentContainer';
import Unlock from 'app/pages/Unlock';
import { Button, ButtonVariant } from 'components/Button';
import { CustomRpsContext } from 'lib/analytics';
import { getAllUncompletedTransactions } from 'lib/miden/activity';
import { ITransactionStatus } from 'lib/miden/db/types';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { MidenDAppPayload } from 'lib/miden/types';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { b64ToU8 } from 'lib/shared/helpers';
import { WalletAccount } from 'lib/shared/types';
import { useRetryableSWR } from 'lib/swr';
import useSafeState from 'lib/ui/useSafeState';
import { navigate, useLocation } from 'lib/woozie';
import { truncateAddress, truncateHash } from 'utils/string';

import Alert from './atoms/Alert';
import FormSecondaryButton from './atoms/FormSecondaryButton';
import FormSubmitButton from './atoms/FormSubmitButton';
import Name from './atoms/Name';
import { AdvancedDetails, FoldableField } from './confirm/AdvancedDetails';
import { declaredRequestToView, summaryBytesToView, summaryToView, TxAssetView } from './confirm/decode';
import { TransactionAssetView } from './confirm/TransactionAssetView';
import { ConfirmPageSelectors } from './ConfirmPage.selectors';
import { Icon, IconName } from './icons/v2';
import AccountBanner from './templates/AccountBanner';
import ConnectBanner from './templates/ConnectBanner';
import PrivateDataPermissionBanner from './templates/PrivateDataPermissionBanner';
import PrivateDataPermissionCheckbox from './templates/PrivateDataPermissionCheckbox';

const ConfirmPage: FC = () => {
  const { t } = useTranslation();
  const { ready } = useMidenContext();

  return useMemo(
    () =>
      ready ? (
        <ContentContainer
          padding={false}
          className={classNames('min-h-screen', 'flex flex-col items-center justify-center bg-app-bg')}
        >
          <ErrorBoundary whileMessage={t('fetchingConfirmationDetails')}>
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-screen bg-app-bg">
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

const OpaqueSignatureWarning: React.FC<{ rawValue: string }> = ({ rawValue }) => {
  const { t } = useTranslation();
  return (
    <>
      <Alert type="warn" title={t('opaqueSignatureTitle')} description={t('opaqueSignatureWarning')} className="my-2" />
      <AdvancedDetails label={t('rawValue')}>{rawValue}</AdvancedDetails>
    </>
  );
};

/**
 * The "this site is asking for something" header shown above every non-connect
 * approval payload. `origin` is the requesting dApp's origin as recorded when
 * the user connected — it is the only thing on screen that tells the user WHO
 * is asking, so it carries an E2E hook.
 */
const RequestOriginBanner: FC<{ origin: string; children: React.ReactNode }> = ({ origin, children }) => (
  <div
    className={classNames(
      'text-sm text-left text-black',
      'flex w-full gap-x-3 items-center p-4',
      'border border-gray-100 rounded-2xl mb-4'
    )}
  >
    <Icon name={IconName.Globe} fill="currentColor" size="md" />
    <div className="flex flex-col">
      <Name className="font-semibold" data-testid="confirm-request-origin">
        {origin}
      </Name>
      {children}
    </div>
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
          try {
            const word = Word.deserialize(bytes);
            wordHex = word.toHex();
          } catch (e) {
            console.error('Failed to deserialize payload for sign:', e);
          }
          content = <OpaqueSignatureWarning rawValue={wordHex} />;
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

    case 'privateNotes': {
      content = (
        <>
          <div className="text-md text-center my-6">
            {t('sharePrivateNoteDataForAccount')}
            <br />
            {`${truncateAddress(payload.sourcePublicKey)}?`}
          </div>
          <div className="flex items-center justify-center">
            <FormSecondaryButton
              type="button"
              className="justify-center w-3/5 bg-chip-bg hover:bg-gray-100 text-black"
              style={{ fontWeight: '400', border: 'none' }}
              onClick={() => downloadData('privateNotes.json', JSON.stringify(payload.privateNotes, null, 2))}
              small
            >
              {t('downloadPrivateNoteData')}
            </FormSecondaryButton>
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
          <div className="text-sm" key={0}>
            {payload.transactionMessages[0]} <br />
            <span data-testid="confirm-tx-faucet">{payload.transactionMessages[1]}</span>
          </div>
          {account && (
            <>
              <hr className="h-px bg-border-light my-4" />
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">{t('account')}</span>
                <div className="text-black flex flex-col items-end">
                  <span>{account.name}</span>
                  <span>{truncateAddress(account.publicKey)}</span>
                </div>
              </div>
            </>
          )}
          <hr className="h-px bg-border-light my-4" />
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
                <span className="text-black" data-testid={txRowValueTestId(label)}>
                  {value}
                </span>
              </div>
            );
          })}
        </div>
      );
      break;
    }

    case 'consume':
      content = (
        <div>
          <div className="text-sm" key={0}>
            {payload.transactionMessages[0]}
          </div>
          {account && (
            <>
              <hr className="h-px bg-border-light my-4" />
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">{t('account')}</span>
                <div className="text-black flex flex-col items-end">
                  <span>{account.name}</span>
                  <span>{truncateAddress(account.publicKey)}</span>
                </div>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">{t('noteId')}</span>
                <div className="text-black flex flex-col items-end">
                  <span>{truncateHash(payload.noteId)}</span>
                </div>
              </div>
            </>
          )}
          <hr className="h-px bg-border-light my-4" />
          {payload.transactionMessages.slice(1).map((message, i) => {
            const [label, rawValue] = message.split(', ');
            let value = rawValue ?? '';
            if (label === 'Recipient') {
              value = truncateAddress(value);
            }
            return (
              <div className="flex justify-between my-2 text-sm" key={i + 2}>
                <span className="text-text-muted">{label}</span>
                <span className="text-black">{value}</span>
              </div>
            );
          })}
        </div>
      );
      break;
  }

  return (
    <div className={classNames('w-full', 'flex flex-col')}>
      {t('payload') && (
        <h2 className={classNames('mb-2', 'leading-tight', 'flex flex-col')}>
          <span className="text-black font-medium" style={{ fontSize: '14px', lineHeight: '20px' }}>
            {t('payload')}
          </span>
        </h2>
      )}
      <span className="text-sm text-black">{error ? error : content}</span>
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

  if (!signingInputs) {
    return <div className="text-md text-center my-6">{t('failedToParseSigningPayload')}</div>;
  }

  switch (signingInputs.variantType) {
    case SigningInputsType.TransactionSummary:
      return (
        <TransactionAssetView
          view={summaryToView(signingInputs.transactionSummaryPayload())}
          mode="verified"
          onDownload={() => downloadBytes('transaction_summary.bin', bytes)}
        />
      );
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
  const [simError, setSimError] = useState(false);

  useEffect(() => {
    if (!payload.requestBytes) return;
    let cancelled = false;
    (async () => {
      try {
        const { summaryBytes } = await simulateCustomTransaction(id);
        if (cancelled) return;
        if (summaryBytes) {
          setVerifiedView(summaryBytesToView(summaryBytes));
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
    <AdvancedDetails>
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
        <TransactionAssetView view={verifiedView} mode="verified" />
        {advanced}
      </>
    );
  }

  if (declaredView) {
    return (
      <>
        <TransactionAssetView view={declaredView} mode="declared" />
        {simError && <div className="text-xs text-text-muted my-2">{t('couldNotVerifyBySimulation')}</div>}
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
    confirmDAppConsumableNotes
  } = useMidenContext();
  const account = useAccount();
  const isPublicAccount = account.isPublic;

  const loc = useLocation();
  const id = useMemo(() => {
    const usp = new URLSearchParams(loc.search);
    const pageId = usp.get('id');
    if (!pageId) {
      throw new Error(t('notIdentified'));
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
  let requirePrivateDataCheckbox = false;
  let privateDataPermission = PrivateDataPermission.UponRequest;
  if (payload.type === 'connect') {
    privateDataPermission = payload.privateDataPermission;
    if (payload.existingPermission) {
      confirmDAppPermission(id, true, account.publicKey, privateDataPermission, payload.allowedPrivateData);
    }
  }
  requirePrivateDataCheckbox = privateDataPermission === PrivateDataPermission.Auto && !isPublicAccount;
  const [isPrivateDataChecked, setIsPrivateDataChecked] = useState(false);
  const delegate = isDelegateProofEnabled();

  const onConfirm = useCallback(
    async (confirmed: boolean) => {
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
          await confirmDAppTransaction(id, confirmed, delegate);
          if (confirmed) {
            // The dApp confirm response carries no txId, but the progress page
            // is addressed by one — resolve the active row from the queue.
            const uncompleted = await getAllUncompletedTransactions();
            const active =
              uncompleted.find(tx => tx.status === ITransactionStatus.GeneratingTransaction) ?? uncompleted[0];
            navigate(active ? `/generating-transaction-full/${encodeURIComponent(active.id)}` : '/');
          }
          return;
        case 'privateNotes':
          return confirmDAppPrivateNotes(id, confirmed);
        case 'sign':
          return confirmDAppSign(id, confirmed);
        case 'assets':
          return confirmDAppAssets(id, confirmed);
        case 'importPrivateNote':
          return confirmDAppImportPrivateNote(id, confirmed);
        case 'consumableNotes':
          return confirmDAppConsumableNotes(id, confirmed);
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
      delegate
    ]
  );

  const [error, setError] = useSafeState<any>(null);
  const [confirming, setConfirming] = useSafeState(false);
  const [declining, setDeclining] = useSafeState(false);

  const confirm = useCallback(
    async (confirmed: boolean) => {
      setError(null);
      try {
        if (confirmed && requirePrivateDataCheckbox && !isPrivateDataChecked) {
          throw new Error(t('confirmError'));
        }
        await onConfirm(confirmed);
      } catch (err: any) {
        console.error(err);

        // Human delay.
        await new Promise(res => setTimeout(res, 300));
        setError(err);
      }
    },
    [onConfirm, setError, requirePrivateDataCheckbox, isPrivateDataChecked, t]
  );

  const handleConfirmClick = useCallback(async () => {
    if (confirming || declining) return;

    setConfirming(true);
    await confirm(true);
    setConfirming(false);
  }, [confirming, declining, setConfirming, confirm]);

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
            <RequestOriginBanner origin={payload.origin}>
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
            <RequestOriginBanner origin={payload.origin}>
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
            <RequestOriginBanner origin={payload.origin}>
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
            <RequestOriginBanner origin={payload.origin}>
              <span className="text-text-muted">{t('requestsYourSignature')}</span>
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
            <RequestOriginBanner origin={payload.origin}>
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
            <RequestOriginBanner origin={payload.origin}>
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
            <RequestOriginBanner origin={payload.origin}>
              <span>{t('requestsConsumableNotes')}</span>
            </RequestOriginBanner>
          )
        };
    }
  }, [error, payload, privateDataPermission, isPublicAccount, t]);

  return (
    <CustomRpsContext.Provider value={'TODO'}>
      <div
        className={classNames('relative bg-surface-solid rounded-md shadow-md overflow-y-auto', 'flex flex-col')}
        style={{
          width: 380,
          height: 610
        }}
      >
        <div className="flex flex-col items-left px-4">
          <h2 className="py-6 flex text-black text-lg font-semibold">{content.title}</h2>

          {payload.type === 'connect' && (
            <ConnectBanner type={payload.type} origin={payload.origin} appMeta={payload.appMeta} />
          )}

          {content.want}

          {error ? (
            <Alert
              closable
              onClose={handleErrorAlertClose}
              type="error"
              title={t('error')}
              description={error?.message ?? t('smthWentWrong')}
              className="my-4"
              autoFocus
            />
          ) : (
            <>
              {payload.type === 'connect' ? (
                account && (
                  <AccountBanner
                    account={account}
                    networkRpc={payload.networkRpc}
                    labelIndent="sm"
                    className="w-full my-2"
                  />
                )
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
              className={classNames('w-full', 'px-8', 'text-black font-medium', 'transition duration-200 ease-in-out')}
              style={{
                fontSize: '16px',
                lineHeight: '24px',
                padding: '14px 0px',
                border: 'none'
              }}
              isLoading={declining}
              onClick={handleDeclineClick}
              data-testid={content.declineActionTestID}
            >
              {content.declineActionTitle}
            </Button>
          </div>

          <div className="w-1/2 pl-2">
            <FormSubmitButton
              type="button"
              className="w-full justify-center justify-center rounded-lg py-3"
              style={{ fontSize: '16px', lineHeight: '24px', padding: '14px 0px', border: 'none' }}
              loading={confirming}
              onClick={handleConfirmClick}
              testID={content.confirmActionTestID}
              data-testid={content.confirmActionTestID}
            >
              {content.confirmActionTitle}
            </FormSubmitButton>
          </div>
        </div>
      </div>
    </CustomRpsContext.Provider>
  );
};
