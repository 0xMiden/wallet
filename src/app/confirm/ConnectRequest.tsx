import React, { FC } from 'react';

import { AllowedPrivateData, PrivateDataPermission } from '@miden-sdk/miden-wallet-adapter-base';
import { useTranslation } from 'react-i18next';

import { ReactComponent as BreadLogo } from 'app/icons/brand/new-bread.svg';
import { Icon, IconName } from 'app/icons/v2';
import { DappNetworkMismatchNotice } from 'components/DappNetworkMismatchNotice';
import { Avatar } from 'components/ui/Avatar';
import { CheckboxConsent } from 'components/ui/Checkbox';
import { DappOrigin } from 'components/ui/DappOrigin';
import { FactRow, IconCircle } from 'components/ui/FactRow';
import { ListGroup } from 'components/ui/ListGroup';
import { Notice } from 'components/ui/Notice';
import { Pill } from 'components/ui/Pill';
import { SectionHeader } from 'components/ui/SectionHeader';
import { formatAllowedPrivateData, grantsStandingPrivateDataAccess } from 'lib/dapp-browser/private-data-scope';
import { hapticSelection } from 'lib/mobile/haptics';
import { WalletAccount } from 'lib/shared/types';
import { UserErrorId } from 'lib/telemetry/user-visible-error';
import { truncateAddress } from 'utils/string';

/**
 * What a fact says about the site: something it can do (sage check), something that still needs the
 * user (accent alert), something it can never do (clay cross). The circle treatment is
 * `GuardianInfoDrawer`'s, so "what it can and cannot do" reads the same across the wallet.
 */
type FactKind = 'can' | 'ask' | 'cannot';

const FACT_CIRCLE: Record<FactKind, { className: string; icon: IconName }> = {
  can: { className: 'bg-positive-tint-ink text-positive-tint', icon: IconName.FactCheck },
  ask: { className: 'bg-accent-tint-ink text-accent-tint', icon: IconName.FactAlert },
  cannot: { className: 'bg-negative-tint-ink text-negative-tint', icon: IconName.FactCross }
};

const Fact: FC<{ kind: FactKind; title: string; description?: string; testId: string }> = ({
  kind,
  title,
  description,
  testId
}) => (
  <FactRow
    leading={
      <IconCircle className={FACT_CIRCLE[kind].className}>
        <Icon name={FACT_CIRCLE[kind].icon} size="xs" fill="currentColor" />
      </IconCircle>
    }
    title={<span className="font-extrabold">{title}</span>}
    description={description}
    data-testid={testId}
  />
);

export interface ConnectRequestProps {
  origin: string;
  account: WalletAccount;
  isPublicAccount: boolean;
  privateDataPermission: PrivateDataPermission;
  allowedPrivateData: AllowedPrivateData;
  /** The Miden network the dApp claimed; a mismatch with the wallet's draws the warning. */
  claimedNetwork: string | undefined;
  /** Standing private-data access needs the risk tick before Connect is accepted. */
  requireConsent: boolean;
  consentChecked: boolean;
  onConsentChange: (checked: boolean) => void;
  /** A failed answer: shown above the facts, which stay, so Retry is taken with the request in view. */
  error?: { message: string; errorId: UserErrorId | null };
}

/**
 * The body of the extension's connect window: who is asking and as which account, then what the
 * site will be able to do, then the warnings and the consent the request needs.
 */
export const ConnectRequest: FC<ConnectRequestProps> = ({
  origin,
  account,
  isPublicAccount,
  privateDataPermission,
  allowedPrivateData,
  claimedNetwork,
  requireConsent,
  consentChecked,
  onConsentChange,
  error
}) => {
  const { t } = useTranslation();
  const standingAccess = grantsStandingPrivateDataAccess(privateDataPermission, allowedPrivateData);

  return (
    <div className="contents face-heading">
      <div className="flex w-full flex-col gap-5">
        <div className="flex flex-col items-center gap-2 pt-1 pb-2 text-center">
          <div className="mb-1 flex items-center gap-2.5" aria-hidden="true">
            <span className="flex size-16 items-center justify-center rounded-xl bg-fill">
              <BreadLogo style={{ width: 30, height: 'auto' }} />
            </span>
            <span className="flex gap-1">
              <span className="size-1 rounded-full bg-muted opacity-60" />
              <span className="size-1 rounded-full bg-muted opacity-60" />
              <span className="size-1 rounded-full bg-muted opacity-60" />
            </span>
            <span className="flex size-16 items-center justify-center rounded-xl bg-fill text-ink">
              <Icon name={IconName.Globe} fill="currentColor" size="lg" />
            </span>
          </div>
          {/* The only thing on the connect prompt that identifies WHO is asking —
              hooked for E2E so a wrong/spoofed origin fails a test, not just review. */}
          <DappOrigin
            origin={origin}
            className="justify-center text-center text-hero-name text-ink"
            data-testid="connect-origin"
          />
          <Pill haptic={false} className="pl-1" data-testid="connect-account">
            <span className="flex items-center gap-1.5">
              <Avatar size={24} tone="brand" initials={Array.from(account.name.trim())[0]?.toUpperCase() ?? 'B'} />
              <span>{account.name}</span>
              <span className="text-muted">{truncateAddress(account.publicKey)}</span>
            </span>
          </Pill>
          <p className="text-body-sm font-semibold text-muted">
            {isPublicAccount ? t('publicAccountAccessRequest') : t('privateAccountAccessRequest')}
          </p>
        </div>

        {error && (
          <Notice
            variant="fact"
            tone="negative"
            role="alert"
            errorId={error.errorId}
            title={t('connectFailedTitle')}
            icon={<Icon name={IconName.FactCross} size="xs" fill="currentColor" />}
            data-testid="connect-error"
          >
            {error.message}
          </Notice>
        )}

        <section>
          <SectionHeader>{t('connectFactsTitle')}</SectionHeader>
          <ListGroup surface="outline" data-testid="connect-facts">
            {isPublicAccount ? (
              <Fact kind="can" title={t('connectFactSeeBalanceTitle')} testId="connect-fact-balance" />
            ) : standingAccess ? (
              <Fact
                kind="can"
                title={t('connectFactReadPrivateTitle')}
                description={t('connectFactReadPrivateDescription', {
                  scopes: formatAllowedPrivateData(allowedPrivateData)
                })}
                testId="connect-fact-private-auto"
              />
            ) : (
              <Fact
                kind="ask"
                title={t('connectFactAskPrivateTitle')}
                description={t('confirmationRequired')}
                testId="connect-fact-private-ask"
              />
            )}
            <Fact
              kind="ask"
              title={t('connectFactTxRequestsTitle')}
              description={t('connectFactTxRequestsDescription')}
              testId="connect-fact-transactions"
            />
            <Fact
              kind="cannot"
              title={t('connectFactNoFundsTitle')}
              description={t('connectFactNoFundsDescription')}
              testId="connect-fact-funds"
            />
          </ListGroup>
        </section>

        <DappNetworkMismatchNotice claimedNetwork={claimedNetwork} variant="fact" />

        {requireConsent && (
          <CheckboxConsent
            checked={consentChecked}
            onCheckedChange={checked => {
              void hapticSelection();
              onConsentChange(checked);
            }}
            data-testid="connect-private-data-consent"
          >
            <span className="flex flex-col gap-1">
              <span className="text-row-title font-extrabold">{t('confirmRisk')}</span>
              <span className="text-caption-heading text-muted">{t('confirmPrivateDataPermissionDescription')}</span>
            </span>
          </CheckboxConsent>
        )}
      </div>
    </div>
  );
};
