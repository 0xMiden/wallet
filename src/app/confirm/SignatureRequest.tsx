import React, { FC, useMemo } from 'react';

import { SigningInputs, SigningInputsType, Word } from '@miden-sdk/miden-sdk/lazy';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { CopyButton } from 'components/ui/CopyButton';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { Notice } from 'components/ui/Notice';
import { MidenDAppPayload } from 'lib/miden/types';
import { b64ToU8 } from 'lib/shared/helpers';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error';
import { truncateAddress } from 'utils/string';

import { summaryToView } from './decode';
import { noteFlowFromTransaction, NoteFlow } from './note-flow';
import { RequestTiles } from './RequestTiles';
import { quantityOf, useResolvedAssets } from './TransactionAssetView';
import { TransactionNoteFlow } from './TransactionNoteFlow';
import { AmountHeader, FailureNotice, RequestRows, SummaryPill, TransactionRequestError } from './TransactionRequest';

/**
 * The body of the extension's signature windows (`sign` and `loginSign`): the Bread ··· site
 * tiles, then what is being signed, then the request card (which site, which network). The
 * transaction summary takes the transaction windows' header: the amount, then the summary pill.
 */

type SignaturePayload = Extract<MidenDAppPayload, { type: 'sign' | 'loginSign' }>;

/** Which site asked, on which network, and any rows of the request's own. */
const RequestCard: FC<{ origin: string; children?: React.ReactNode }> = ({ origin, children }) => (
  <DetailCard surface="outline" face="heading">
    <RequestRows origin={origin} />
    {children}
  </DetailCard>
);

/** A sentence under the tiles: what the window asks, without a box around it. */
const Lead: FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="-mt-2 px-1 text-body-strong text-muted">{children}</p>
);

/** The value to be signed, shown open; a real digest can be copied. */
const RawValue: FC<{ value: string; copyable: boolean; errorId?: UserErrorId | null }> = ({
  value,
  copyable,
  errorId
}) => {
  const { t } = useTranslation();
  useUserVisibleError(errorId, 'inline');
  return (
    <div className="overflow-hidden rounded-2xl border border-hairline">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="text-value text-ink">{t('rawValue')}</span>
        {copyable && <CopyButton text={value} icon="only" data-testid="confirm-sign-raw-value-copy" />}
      </div>
      <div
        className="whitespace-pre-wrap break-all border-t border-hairline bg-fill/50 px-4 py-3 font-mono text-xs text-ink"
        data-testid="confirm-sign-raw-value"
      >
        {value}
      </div>
    </div>
  );
};

/** A word, an arbitrary payload or a blind commitment: nothing the wallet can read, so a caution first. */
const OpaqueSignature: FC<{ origin: string; value: string; copyable: boolean; errorId?: UserErrorId | null }> = ({
  origin,
  value,
  copyable,
  errorId
}) => {
  const { t } = useTranslation();
  return (
    <>
      <Notice
        variant="fact"
        tone="caution"
        title={t('opaqueSignatureTitle')}
        icon={<Icon name={IconName.FactAlert} size="xs" fill="currentColor" />}
        data-testid="confirm-sign-opaque"
      >
        {t('opaqueSignatureWarning')}
      </Notice>
      <RawValue value={value} copyable={copyable} errorId={errorId} />
      <RequestCard origin={origin} />
    </>
  );
};

const WordSignature: FC<{ origin: string; bytes: Uint8Array }> = ({ origin, bytes }) => {
  const { t } = useTranslation();
  const hex = useMemo(() => {
    try {
      return Word.deserialize(bytes).toHex();
    } catch (e) {
      console.error('Failed to deserialize payload for sign:', e);
      return null;
    }
  }, [bytes]);
  return (
    <OpaqueSignature
      origin={origin}
      value={hex ?? t('invalidPayload')}
      copyable={hex !== null}
      errorId={hex === null ? 'invalidPayload' : null}
    />
  );
};

const SummarySignature: FC<{
  origin: string;
  summary: ReturnType<SigningInputs['transactionSummaryPayload']>;
  bytes: Uint8Array;
}> = ({ origin, summary, bytes }) => {
  const { t } = useTranslation();
  const view = useMemo(() => summaryToView(summary), [summary]);
  const noteFlow = useMemo<NoteFlow | undefined>(() => {
    try {
      return noteFlowFromTransaction(summary);
    } catch (noteError) {
      console.error('Signing summary note details unavailable:', noteError);
      return undefined;
    }
  }, [summary]);
  const outgoing = useResolvedAssets(view.outgoing);
  const incoming = useResolvedAssets(view.incoming);
  const feeAssets = useMemo(() => (view.fee ? [view.fee] : []), [view.fee]);
  const [feeAsset] = useResolvedAssets(feeAssets);

  const lines = [
    ...outgoing.map(a => ({ amount: `-${quantityOf(a)}`, symbol: a.symbol ?? t('unknown'), incoming: false })),
    ...view.outgoingNfts.map(nft => ({ amount: `-${t('nft')} ${nft.assetId}`, incoming: false })),
    ...incoming.map(a => ({ amount: `+${quantityOf(a)}`, symbol: a.symbol ?? t('unknown'), incoming: true })),
    ...view.incomingNfts.map(nft => ({ amount: `+${t('nft')} ${nft.assetId}`, incoming: true }))
  ];

  return (
    <div className="contents" data-testid="tx-asset-view" data-mode="verified" data-account={view.account ?? ''}>
      <AmountHeader
        lines={lines}
        pill={
          <SummaryPill>
            <Icon name={IconName.Code} size="xs" fill="currentColor" className="shrink-0 text-muted" />
            <span className="truncate">{t('confirmSignTransactionSummary')}</span>
          </SummaryPill>
        }
      />

      {view.unlistedAssets > 0 && (
        <Notice
          variant="fact"
          tone="warning"
          icon={<Icon name={IconName.FactAlert} size="xs" fill="currentColor" />}
          data-testid="tx-unlisted-assets"
        >
          {t('unlistedAssetsWarning')}
        </Notice>
      )}

      <RequestCard origin={origin}>
        {view.account && <DetailRow label={t('account')}>{truncateAddress(view.account)}</DetailRow>}
        <DetailRow label={t('inputNotesConsumed')}>{view.inputNotesConsumed}</DetailRow>
        <DetailRow label={t('outputNotesCreated')}>
          <span data-testid="tx-output-notes-created">{view.outputNotesCreated}</span>
        </DetailRow>
        {view.fee && (
          <DetailRow label={t('networkFee')}>
            <span data-testid="tx-network-fee">
              {feeAsset ? `${quantityOf(feeAsset)} ${feeAsset.symbol ?? t('unknown')}` : t('loading')}
            </span>
          </DetailRow>
        )}
        <DetailRow label={t('storageChanged')}>
          {view.storageChanged ? (
            <span className="flex items-center gap-1.5">
              <Icon name={IconName.WarningFill} size="xs" fill="currentColor" className="text-pending-ink" />
              <span data-testid="tx-storage-changed" data-changed="true">
                {t('yes')}
              </span>
            </span>
          ) : (
            <span data-testid="tx-storage-changed" data-changed="false">
              {t('no')}
            </span>
          )}
        </DetailRow>
      </RequestCard>

      {noteFlow ? (
        <TransactionNoteFlow flow={noteFlow} account={view.account} />
      ) : (
        <p className="px-1 text-center text-body-strong text-muted" data-testid="tx-note-flow-unavailable">
          {t('verifiedNoteDetailsUnavailable')}
        </p>
      )}

      <Button
        type="button"
        variant={ButtonVariant.Ghost}
        size="sm"
        className="w-full"
        iconLeft={IconName.Download}
        title={t('downloadFullSummary')}
        onClick={() => downloadBytes('transaction_summary.bin', bytes)}
      />
    </div>
  );
};

const SigningInputsSignature: FC<{ origin: string; bytes: Uint8Array }> = ({ origin, bytes }) => {
  const { t } = useTranslation();
  const signingInputs = useMemo(() => {
    try {
      return SigningInputs.deserialize(bytes);
    } catch (e) {
      console.error('Failed to deserialize payload for sign:', e);
      return null;
    }
  }, [bytes]);
  const summary = useMemo(
    () =>
      signingInputs?.variantType === SigningInputsType.TransactionSummary
        ? signingInputs.transactionSummaryPayload()
        : null,
    [signingInputs]
  );

  if (!signingInputs) {
    return (
      <>
        <Notice
          variant="fact"
          tone="negative"
          role="alert"
          errorId="failedToParseSigningPayload"
          title={t('failedToParseSigningPayload')}
          icon={<Icon name={IconName.FactCross} size="xs" fill="currentColor" />}
          data-testid="confirm-sign-parse-failed"
        />
        <RequestCard origin={origin} />
      </>
    );
  }

  if (summary) return <SummarySignature origin={origin} summary={summary} bytes={bytes} />;

  if (
    signingInputs.variantType === SigningInputsType.Arbitrary ||
    signingInputs.variantType === SigningInputsType.Blind
  ) {
    return (
      <OpaqueSignature
        origin={origin}
        copyable={false}
        value={
          signingInputs.variantType === SigningInputsType.Arbitrary
            ? t('signArbitraryPayload')
            : t('signBlindCommitment')
        }
      />
    );
  }

  return <NoPreview origin={origin} />;
};

const NoPreview: FC<{ origin: string }> = ({ origin }) => {
  const { t } = useTranslation();
  return (
    <>
      <Lead>{t('noPreview')}</Lead>
      <RequestCard origin={origin} />
    </>
  );
};

const SignBody: FC<{ payload: Extract<SignaturePayload, { type: 'sign' }> }> = ({ payload }) => {
  const bytes = useMemo(() => b64ToU8(payload.payload), [payload.payload]);
  switch (payload.kind) {
    case 'word':
      return <WordSignature origin={payload.origin} bytes={bytes} />;
    case 'signingInputs':
      return <SigningInputsSignature origin={payload.origin} bytes={bytes} />;
    default:
      return <NoPreview origin={payload.origin} />;
  }
};

// The login key signs only sign-ins to its own site, so a login shows no opaque-signature warning.
const LoginBody: FC<{ payload: Extract<SignaturePayload, { type: 'loginSign' }> }> = ({ payload }) => {
  const { t } = useTranslation();
  return (
    <>
      <Lead>{t('loginSignatureNote', { domain: payload.domain })}</Lead>
      <RequestCard origin={payload.origin}>
        <DetailRow label={t('account')} stacked data-testid="confirm-login-account">
          <span className="min-w-0">{payload.accountId}</span>
          <CopyButton text={payload.accountId} data-testid="confirm-login-account-copy" />
        </DetailRow>
      </RequestCard>
    </>
  );
};

export const SignatureRequest: FC<{
  payload: SignaturePayload;
  /** The payload could not be prepared: shown in place of what is signed. */
  payloadError?: React.ReactNode;
  /** A failed answer: shown above the request, which stays, so Retry is taken with it in view. */
  error?: TransactionRequestError;
}> = ({ payload, payloadError, error }) => {
  const { t } = useTranslation();
  return (
    <div className="contents face-heading">
      <div className="flex w-full flex-col gap-5">
        <RequestTiles className="self-center" />
        {error && <FailureNotice message={error.message} errorId={error.errorId} />}
        {payloadError ? (
          <>
            <Notice
              variant="fact"
              tone="negative"
              role="alert"
              errorId="raw_confirm_payload_failed"
              title={t('confirmTxFailedTitle')}
              icon={<Icon name={IconName.FactCross} size="xs" fill="currentColor" />}
              data-testid="confirm-sign-payload-error"
            >
              {payloadError}
            </Notice>
            <RequestCard origin={payload.origin} />
          </>
        ) : payload.type === 'loginSign' ? (
          <LoginBody payload={payload} />
        ) : (
          <SignBody payload={payload} />
        )}
      </div>
    </div>
  );
};

function downloadBytes(filename: string, data: Uint8Array, mimeType = 'application/octet-stream') {
  const blob = new Blob([data as BlobPart], { type: mimeType });
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
