/* eslint-disable no-restricted-globals */

import React, { FC, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { PrivateDataPermission } from '@demox-labs/miden-wallet-adapter-base';
import { Address, FungibleAsset, NetworkId, SigningInputs, SigningInputsType, Word } from '@miden-sdk/miden-sdk';
import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import Spinner from 'app/atoms/Spinner/Spinner';
import ErrorBoundary from 'app/ErrorBoundary';
import ContentContainer from 'app/layouts/ContentContainer';
import Unlock from 'app/pages/Unlock';
import { Button, ButtonVariant } from 'components/Button';
import { CustomRpsContext } from 'lib/analytics';
import { AssetMetadata, MIDEN_METADATA, useAccount, useMidenContext } from 'lib/miden/front';
import { getTokenMetadata } from 'lib/miden/metadata/utils';
import { MidenDAppPayload } from 'lib/miden/types';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { formatAmount } from 'lib/shared/format';
import { b64ToU8 } from 'lib/shared/helpers';
import { WalletAccount } from 'lib/shared/types';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import useSafeState from 'lib/ui/useSafeState';
import useTippy from 'lib/ui/useTippy';
import { useLocation } from 'lib/woozie';
import { truncateAddress, truncateHash } from 'utils/string';

import Alert from './atoms/Alert';
import FormSecondaryButton from './atoms/FormSecondaryButton';
import FormSubmitButton from './atoms/FormSubmitButton';
import Name from './atoms/Name';
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
          className={classNames('min-h-screen', 'flex flex-col items-center justify-center')}
        >
          <ErrorBoundary whileMessage={t('fetchingConfirmationDetails')}>
            <Suspense
              fallback={
                <div className="flex items-center justify-center h-screen">
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

interface PayloadContentProps {
  payload: MidenDAppPayload;
  account?: WalletAccount;
  viewKey?: string;
  error?: any;
}

const PayloadContent: React.FC<PayloadContentProps> = ({ payload, error, account }) => {
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
          content = (
            <div className="text-md text-center my-6">
              {t('signTheFollowingWord', { word: truncateAddress(wordHex) })}
            </div>
          );
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
              className="justify-center w-3/5 bg-gray-800 hover:bg-gray-700 text-black"
              style={{ fontWeight: '400', color: 'black', border: 'none' }}
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
      content = (
        <div>
          <div className="text-sm" key={0}>
            {payload.transactionMessages[0]} <br />
            {payload.transactionMessages[1]}
          </div>
          {account && (
            <>
              <hr className="h-px bg-grey-100 my-4" />
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">{t('account')}</span>
                <div className="text-black flex flex-col items-end">
                  <span>{account.name}</span>
                  <span>{truncateAddress(account.publicKey)}</span>
                </div>
              </div>
            </>
          )}
          <hr className="h-px bg-grey-100 my-4" />
          {payload.transactionMessages.slice(2).map((message, i) => {
            const [label, rawValue] = message.split(', ');
            let value = rawValue;
            if (label === 'Amount') {
              const microcredits = Number(value);
              const amount = microcredits / 10 ** MIDEN_METADATA.decimals;
              value = amount.toString();
            } else if (label === 'Recipient') {
              value = truncateAddress(value);
            }
            return (
              <div className="flex justify-between my-2 text-sm" key={i + 2}>
                <span className="text-gray-600">{label}</span>
                <span className="text-black">{value}</span>
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
              <hr className="h-px bg-grey-100 my-4" />
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">{t('account')}</span>
                <div className="text-black flex flex-col items-end">
                  <span>{account.name}</span>
                  <span>{truncateAddress(account.publicKey)}</span>
                </div>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">{t('noteId')}</span>
                <div className="text-black flex flex-col items-end">
                  <span>{truncateHash(payload.noteId)}</span>
                </div>
              </div>
            </>
          )}
          <hr className="h-px bg-grey-100 my-4" />
          {payload.transactionMessages.slice(1).map((message, i) => {
            const [label, rawValue] = message.split(', ');
            let value = rawValue;
            if (label === 'Recipient') {
              value = truncateAddress(value);
            }
            return (
              <div className="flex justify-between my-2 text-sm" key={i + 2}>
                <span className="text-gray-600">{label}</span>
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
      {t('Payload') && (
        <h2 className={classNames('mb-2', 'leading-tight', 'flex flex-col')}>
          <span className="text-black font-medium" style={{ fontSize: '14px', lineHeight: '20px' }}>
            {t('Payload')}
          </span>
        </h2>
      )}
      <span className="text-sm text-black">{error ? error : content}</span>
    </div>
  );
};

type FungibleAssetDetails = {
  asset: FungibleAsset;
  metadata: AssetMetadata;
};

const SigningInputsPayloadContent: React.FC<{ bytes: Uint8Array }> = ({ bytes }) => {
  const { t } = useTranslation();
  const [removedFungibleAssets, setRemovedFungibleAssets] = useState<FungibleAsset[]>([]);
  const [addedFungibleAssets, setAddedFungibleAssets] = useState<FungibleAsset[]>([]);
  const [removedFungibleAssetsDetails, setRemovedFungibleAssetsDetails] = useState<FungibleAssetDetails[]>([]);
  const [addedFungibleAssetsDetails, setAddedFungibleAssetsDetails] = useState<FungibleAssetDetails[]>([]);

  let content: string | React.ReactNode = t('noPreview');
  const tippyProps = {
    trigger: 'mouseenter',
    hideOnClick: false,
    content: t('transactionAffectsAccountStorage'),
    animation: 'shift-away-subtle'
  };

  const iconAnchorRef = useTippy<HTMLElement>(tippyProps);

  const signingInputs = useMemo(() => {
    try {
      return SigningInputs.deserialize(bytes);
    } catch (e) {
      console.error('Failed to deserialize payload for sign:', e);
      return null;
    }
  }, [bytes]);

  // Derive asset arrays from signing inputs variant; avoid setState during render
  useEffect(() => {
    if (!signingInputs) {
      setAddedFungibleAssets([]);
      setRemovedFungibleAssets([]);
      return;
    }
    if (signingInputs.variantType === SigningInputsType.TransactionSummary) {
      const ts = signingInputs.transactionSummaryPayload();
      const vault = ts.accountDelta().vault();
      setAddedFungibleAssets(vault.addedFungibleAssets());
      setRemovedFungibleAssets(vault.removedFungibleAssets());
    } else {
      setAddedFungibleAssets([]);
      setRemovedFungibleAssets([]);
    }
  }, [signingInputs]);

  useEffect(() => {
    const fetchFungibleAssets = async () => {
      const removedFungibleAssetsDetails = await Promise.all(
        removedFungibleAssets.map(async asset => {
          const metadata = await getTokenMetadata(asset.faucetId().toString());
          return {
            asset,
            metadata
          };
        })
      );
      setRemovedFungibleAssetsDetails(removedFungibleAssetsDetails);
    };
    fetchFungibleAssets();
  }, [removedFungibleAssets]);

  useEffect(() => {
    const fetchFungibleAssets = async () => {
      const addedFungibleAssetsDetails = await Promise.all(
        addedFungibleAssets.map(async asset => {
          const metadata = await getTokenMetadata(asset.faucetId().toString());
          return {
            asset,
            metadata
          };
        })
      );
      setAddedFungibleAssetsDetails(addedFungibleAssetsDetails);
    };
    fetchFungibleAssets();
  }, [addedFungibleAssets]);

  if (!signingInputs) {
    content = <div className="text-md text-center my-6">{t('failedToParseSigningPayload')}</div>;
  } else {
    const variant = signingInputs.variantType;

    switch (variant) {
      case SigningInputsType.TransactionSummary: {
        console.log('starting case SigningInputsType.TransactionSummary');
        const ts = signingInputs.transactionSummaryPayload();
        const accountDelta = ts.accountDelta();
        const accountAddress = Address.fromAccountId(accountDelta.id(), 'BasicWallet');
        const accountAddressAsBech32 = accountAddress.toBech32(NetworkId.testnet());
        const vault = accountDelta.vault();
        const storage = accountDelta.storage();
        const inputNotes = ts.inputNotes();
        const numNotes = inputNotes.numNotes();
        const outputNotes = ts.outputNotes();
        const numOutputNotes = outputNotes.numNotes();
        console.log('end case SigningInputsType.TransactionSummary');

        content = (
          <div className="flex flex-col items-center justify-center">
            <div className="flex flex-col border border-gray-100 rounded-2xl mb-4 w-full p-4">
              <div
                className={`flex flex-row w-full items-center justify-between border-gray-100 ${
                  vault.isEmpty() ? '' : 'border-b pb-4'
                }`}
              >
                <div className="flex flex-row text-md text-center items-center gap-x-3">
                  <Icon name={IconName.Globe} fill="currentColor" size="md" />
                  <span className="text-gray-600">{t('account')}</span>
                </div>
                <div>{`${truncateAddress(accountAddressAsBech32)}`}</div>
              </div>

              {!vault.isEmpty() && (
                <div className="flex flex-col w-full pt-4">
                  <span className="text-gray-600">{t('assetChanges')}</span>
                  {removedFungibleAssets.length > 0 &&
                    removedFungibleAssetsDetails.map(details => (
                      <div key={details.asset.faucetId().toString()} className="flex flex-col w-full my-2 text-sm">
                        <span className="text-black-500 text-lg font-semibold">
                          {`${formatAmount(details.asset.amount(), 'send', details.metadata.decimals)} ${
                            details.metadata.symbol ?? t('unknown')
                          }`}
                        </span>
                        <span className="text-gray-600">{`~$${details.asset.amount()}`}</span>
                      </div>
                    ))}

                  {addedFungibleAssets.length > 0 &&
                    addedFungibleAssetsDetails.map(details => (
                      <div key={details.asset.faucetId().toString()} className="flex flex-col w-full my-2 text-sm">
                        <span className="text-green-500 text-lg font-semibold">
                          {`${formatAmount(details.asset.amount(), 'consume', details.metadata.decimals)} ${
                            details.metadata.symbol ?? t('unknown')
                          }`}
                        </span>
                        <span className="text-gray-600">{`~$${details.asset.amount()}`}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
            <div className="flex flex-col w-full border-b border-gray-100 pb-4">
              <div className="flex flex-row w-full items-center justify-between pb-1">
                <span className="text-gray-600">{t('inputNotesConsumed')}</span>
                <span>{numNotes}</span>
              </div>
              <div className="flex flex-row w-full items-center justify-between pb-1">
                <span className="text-gray-600">{t('outputNotesCreated')}</span>
                <span>{numOutputNotes}</span>
              </div>
              <div className="flex flex-row w-full items-center justify-between">
                <span className="text-gray-600">{t('storageChanged')}</span>
                {storage.isEmpty() ? (
                  <span>{t('no')}</span>
                ) : (
                  <div className="flex flex-row items-center gap-x-2">
                    <span ref={iconAnchorRef} className="inline-flex align-middle">
                      <Icon name={IconName.WarningFill} fill="orange" size="md" />
                    </span>
                    <span>{t('yes')}</span>
                  </div>
                )}
              </div>
            </div>
            <Button
              type="button"
              variant={ButtonVariant.Ghost}
              className={classNames(
                'w-full mt-2',
                'rounded-4xl hover:rounded-4xl',
                'transition-all duration-200 ease-in-out',
                'hover:bg-gray-100',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300',
                'py-4 px-0'
              )}
              onClick={() => downloadBytes('transaction_summary.bin', bytes)}
            >
              <span className="flex flex-row items-center justify-center gap-x-2">
                <Icon name={IconName.Download} fill="currentColor" size="md" />
                <span className="text-lg text-black font-medium">{t('downloadFullSummary')}</span>
              </span>
            </Button>
          </div>
        );
        break;
      }
      case SigningInputsType.Arbitrary: {
        content = <div className="text-md text-center my-6">{t('signArbitraryPayload')}</div>;
        break;
      }
      case SigningInputsType.Blind: {
        content = <div className="text-md text-center my-6">{t('signBlindCommitment')}</div>;
        break;
      }
    }
  }

  return content;
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
  }, [loc.search]);

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
          useWalletStore.getState().openTransactionModal();
          return confirmDAppTransaction(id, confirmed, delegate);
        case 'consume':
          useWalletStore.getState().openTransactionModal();
          return confirmDAppTransaction(id, confirmed, delegate);
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
    [onConfirm, setError, requirePrivateDataCheckbox, isPrivateDataChecked]
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
            <div
              className={classNames(
                'text-sm text-left text-black',
                'flex w-full gap-x-3 items-center p-4',
                'border border-gray-100 rounded-2xl mb-4'
              )}
            >
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <div className="flex flex-col">
                <Name className="font-semibold">{payload.origin}</Name>
                <span>{t('requestsATransaction')}</span>
              </div>
            </div>
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
            <div
              className={classNames(
                'text-sm text-left text-black',
                'flex w-full gap-x-3 items-center p-4',
                'border border-gray-100 rounded-2xl mb-4'
              )}
            >
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <div className="flex flex-col">
                <Name className="font-semibold">{payload.origin}</Name>
                <span>{t('requestsToConsumeNote')}</span>
              </div>
            </div>
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
            <div
              className={classNames(
                'text-sm text-left text-black',
                'flex w-full gap-x-3 items-center p-4',
                'border border-gray-100 rounded-2xl mb-4'
              )}
            >
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <div className="flex flex-col">
                <Name className="font-semibold">{payload.origin}</Name>
                <span>{t('requestsPrivateNotes')}</span>
              </div>
            </div>
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
            <div
              className={classNames(
                'text-sm text-left text-black',
                'flex w-full gap-x-3 items-center p-4',
                'border border-gray-100 rounded-2xl mb-4'
              )}
            >
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <div className="flex flex-col">
                <Name className="font-semibold">{payload.origin}</Name>
                <span className="text-gray-600">{t('requestsYourSignature')}</span>
              </div>
            </div>
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
            <div
              className={classNames(
                'text-sm text-left text-black',
                'flex w-full gap-x-3 items-center p-4',
                'border border-gray-100 rounded-2xl mb-4'
              )}
            >
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <div className="flex flex-col">
                <Name className="font-semibold">{payload.origin}</Name>
                <span>{t('requestsAssets')}</span>
              </div>
            </div>
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
            <div
              className={classNames(
                'text-sm text-left text-black',
                'flex w-full gap-x-3 items-center p-4',
                'border border-gray-100 rounded-2xl mb-4'
              )}
            >
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <div className="flex flex-col">
                <Name className="font-semibold">{payload.origin}</Name>
                <span>{t('importPrivateNote')}</span>
              </div>
            </div>
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
            <div
              className={classNames(
                'text-sm text-left text-black',
                'flex w-full gap-x-3 items-center p-4',
                'border border-gray-100 rounded-2xl mb-4'
              )}
            >
              <Icon name={IconName.Globe} fill="currentColor" size="md" />
              <div className="flex flex-col">
                <Name className="font-semibold">{payload.origin}</Name>
                <span>{t('requestsConsumableNotes')}</span>
              </div>
            </div>
          )
        };
    }
  }, [error, payload, privateDataPermission, isPublicAccount]);

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
                <PayloadContent payload={payload} error={payloadError} account={account} />
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
            >
              {content.confirmActionTitle}
            </FormSubmitButton>
          </div>
        </div>
      </div>
    </CustomRpsContext.Provider>
  );
};
