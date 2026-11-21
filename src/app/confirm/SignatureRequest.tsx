import React, { FC, useMemo } from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { CopyButton } from 'components/ui/CopyButton';
import { DetailCard, DetailRow } from 'components/ui/DetailCard';
import { IconCircle } from 'components/ui/FactRow';
import { Notice } from 'components/ui/Notice';
import { signableArbitraryElements } from 'lib/miden/dapp-sign-inputs';
import { MidenDAppPayload } from 'lib/miden/types';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { UserErrorId } from 'lib/telemetry/user-visible-error';

import { RequestTiles } from './RequestTiles';
import { FailureNotice, RequestRows, TransactionRequestError } from './TransactionRequest';

/**
 * The body of the extension's signature windows (`sign` and `loginSign`): the Bread ··· site
 * tiles, then what is being signed, then the request card (which site, which network).
 */

type SignaturePayload = Extract<MidenDAppPayload, { type: 'sign' | 'loginSign' }>;

/** Which site asked, on which network, and any rows of the request's own. */
const RequestCard: FC<{ origin: string; children?: React.ReactNode }> = ({ origin, children }) => (
  <DetailCard surface="outline" face="heading">
    <RequestRows origin={origin} />
    {children}
  </DetailCard>
);

/** The body's heading: a toned glyph in its circle and a title, then the sentence that explains it. */
const Headline: FC<{
  icon: React.ReactNode;
  tone: string;
  title: string;
  children: React.ReactNode;
  'data-testid'?: string;
}> = ({ icon, tone, title, children, 'data-testid': testId }) => (
  <div className="flex flex-col gap-2 px-1" data-testid={testId}>
    <div className="flex items-center gap-2.5">
      <IconCircle className={tone}>{icon}</IconCircle>
      <h3 className="text-title-page text-ink">{title}</h3>
    </div>
    <p className="text-body-strong font-bold text-muted">{children}</p>
  </div>
);

/** The value to be signed, shown open. */
const RawValue: FC<{ value: string; errorId?: UserErrorId | null }> = ({ value, errorId }) => {
  const { t } = useTranslation();
  useUserVisibleError(errorId, 'inline');
  return (
    <div className="overflow-hidden rounded-2xl border border-hairline">
      <div className="px-4 py-3 text-value text-ink">{t('rawValue')}</div>
      <div
        className="whitespace-pre-wrap break-all border-t border-hairline bg-fill/50 px-4 py-3 text-body-sm font-semibold text-ink"
        data-testid="confirm-sign-raw-value"
      >
        {value}
      </div>
    </div>
  );
};

/**
 * A message of field elements, the only signature the wallet signs: an `Arbitrary` signing input whose preimage has
 * no protocol message layout (`signableArbitraryElements`). The wallet cannot say what it means, so the caution is the
 * body's heading and the elements are shown open.
 */
const MessageSignature: FC<{ origin: string; elements: bigint[] }> = ({ origin, elements }) => {
  const { t } = useTranslation();
  return (
    <>
      <Headline
        icon={<Icon name={IconName.Exclamation} size="xs" fill="currentColor" />}
        tone="bg-pending-tint-ink text-page"
        title={t('signMessageTitle')}
        data-testid="confirm-sign-message"
      >
        {t('signMessageWarning', { count: elements.length })}
      </Headline>
      <RawValue value={elements.join(', ')} />
      <RequestCard origin={origin} />
    </>
  );
};

/** Any other request: the background refuses it before this window opens, so this is a backstop. */
const RefusedSignature: FC<{ origin: string }> = ({ origin }) => {
  const { t } = useTranslation();
  return (
    <>
      <Notice
        variant="fact"
        tone="negative"
        role="alert"
        title={t('signRequestRefusedTitle')}
        icon={<Icon name={IconName.FactCross} size="xs" fill="currentColor" />}
        data-testid="confirm-sign-refused"
      >
        {t('signRequestRefused')}
      </Notice>
      <RequestCard origin={origin} />
    </>
  );
};

const SignBody: FC<{ payload: Extract<SignaturePayload, { type: 'sign' }> }> = ({ payload }) => {
  const elements = useMemo(() => signableArbitraryElements(payload.kind, payload.payload), [payload]);
  return elements ? (
    <MessageSignature origin={payload.origin} elements={elements} />
  ) : (
    <RefusedSignature origin={payload.origin} />
  );
};

// The login key signs only sign-ins to its own site, so a login shows no opaque-signature warning.
const LoginBody: FC<{ payload: Extract<SignaturePayload, { type: 'loginSign' }> }> = ({ payload }) => {
  const { t } = useTranslation();
  return (
    <>
      <Headline
        icon={<Icon name={IconName.SignInKey} size="xs" fill="currentColor" />}
        tone="bg-positive-tint-ink text-page [&>svg]:h-5 [&>svg]:w-5"
        title={t('loginSignatureTitle')}
        data-testid="confirm-login-headline"
      >
        {t('loginSignatureNote', { domain: payload.domain })}
      </Headline>
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
