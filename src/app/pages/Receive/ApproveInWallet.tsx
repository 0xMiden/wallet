import React from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { formatBalance, type DepositTokenConfig } from 'lib/deposit-bridge';
import { hapticLight } from 'lib/mobile/haptics';
import { truncateAddress } from 'utils/string';

/**
 * How the deposit is being funded, which is the only thing that differs between
 * the three variants of this screen:
 *  - `walletconnect` — a session exists; the request is pushed to that wallet.
 *  - `deeplink`      — handed to an installed wallet by URI; re-openable.
 *  - `address`       — the user sends it themselves from anywhere, so there is
 *                      nothing to re-open and no signal but the chain.
 */
export type DepositApproveMethod = 'walletconnect' | 'deeplink' | 'address';

export interface ApproveInWalletProps {
  token: DepositTokenConfig;
  /** Requested deposit amount in base units. */
  amount: bigint;
  /** Vault-derived deposit address the funds are being sent to. */
  evmAddress: string;
  method: DepositApproveMethod;
  /** Wallet the request was handed to; falsy falls back to a generic label. */
  walletName?: string;
  /** Pre-formatted bridge fee (the solver's spread). Omitted for fee-less routes. */
  bridgeFeeText?: string;
  /** True once a matching payment is seen on Sepolia but not yet confirmed. */
  confirming?: boolean;
  /** The user has said they sent it; the CTA stops offering to open a wallet. */
  claimedSent?: boolean;
  /** The deposit actually landed — the only state the wallet can vouch for. */
  detected?: boolean;
  onPrimary: () => void;
  onCancel: () => void;
}

/**
 * Fiat has no source for EVM-side assets yet (wallet prices come from Miden
 * asset metadata). The row is built now so the layout is final.
 */
const FIAT_PLACEHOLDER = '—';

interface StepRowProps {
  title: string;
  subtitle?: string;
  state: 'active' | 'pending' | 'complete';
  isLast?: boolean;
}

/**
 * Local to this screen rather than the generating-transaction `TransactionStepRow`:
 * that row is keyed to a `TransactionStepDescriptor` with an i18n label key and a
 * per-step duration, and has no subtitle — which is the whole point of these two.
 */
const StepRow: React.FC<StepRowProps> = ({ title, subtitle, state, isLast }) => (
  <div className="flex gap-3">
    <div className="flex flex-col items-center">
      <span
        className={classNames(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
          state === 'complete' && 'border-status-positive bg-status-positive',
          state === 'active' && 'border-transparent bg-gray-50',
          state === 'pending' && 'border-rule-default bg-pure-white'
        )}
      >
        {state === 'complete' && (
          <Icon name={IconName.Checkmark} size="xs" fill="currentColor" className="text-pure-white" />
        )}
      </span>
      {!isLast && <span className="w-px flex-1 bg-rule-default" />}
    </div>
    <div className={classNames('flex flex-col', !isLast && 'pb-6')}>
      <span className="font-heading text-base font-bold text-heading-gray">{title}</span>
      {subtitle && <span className="text-sm leading-snug text-heading-gray opacity-60">{subtitle}</span>}
    </div>
  </div>
);

interface DetailRowProps {
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}

const DetailRow: React.FC<DetailRowProps> = ({ label, value, sub, testId }) => (
  <div className="flex items-start justify-between gap-3 py-3">
    <span className="shrink-0 font-heading text-base font-bold text-heading-gray">{label}</span>
    <span className="flex min-w-0 flex-col items-end">
      <span className="truncate font-heading text-base font-bold text-heading-gray" data-testid={testId}>
        {value}
      </span>
      {sub && <span className="truncate text-sm text-heading-gray opacity-60">{sub}</span>}
    </span>
  </div>
);

/**
 * Shown while the deposit address is waiting to be funded. The wallet cannot
 * sign this transfer — it belongs to whoever holds the sending account — so the
 * screen's whole job is to state exactly what was requested and then watch the
 * chain. It is replaced by the bridge review the moment the funds land.
 */
export const ApproveInWallet: React.FC<ApproveInWalletProps> = ({
  token,
  amount,
  evmAddress,
  method,
  walletName,
  bridgeFeeText,
  confirming,
  claimedSent,
  detected,
  onPrimary,
  onCancel
}) => {
  const { t } = useTranslation();

  const wallet = walletName || t('depositWalletDefaultName');
  const amountText = `${formatBalance(amount, token.decimals)} ${token.symbol}`;

  /**
   * One button, three states, in the order the user moves through them:
   * go pay it → tell us you paid → we can see it ourselves. Detection wins over
   * the user's word, because it is the only one of the three the wallet knows.
   */
  const primaryTitle = detected
    ? t('depositFundsDetected')
    : claimedSent || method === 'address'
      ? t('depositSentTheFunds')
      : method === 'deeplink'
        ? t('depositOpenWallet', { wallet })
        : t('approveInWallet', { wallet });

  // The address variant has no wallet to name — nobody was handed the request.
  const headline = method === 'address' ? t('depositAwaitingTransfer') : t('approveInWallet', { wallet });
  const explainer = method === 'address' ? t('depositAwaitingTransferBody') : t('approveInWalletBody');

  return (
    <div className="flex flex-col px-6 pb-6" data-testid="deposit-approve-in-wallet">
      <div className="flex items-center justify-center gap-3 pb-5">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-50">
          <Icon name={IconName.Send} size="lg" className="text-heading-gray" />
        </span>
        <Icon name={IconName.ArrowRight} size="sm" className="text-heading-gray opacity-40" />
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
          <Icon name={IconName.Wallet} size="lg" className="text-heading-gray" />
        </span>
      </div>

      <div className="rounded-full bg-gray-50 px-4 py-3 text-center">
        <span className="font-heading text-lg font-bold text-heading-gray">{headline}</span>
      </div>
      <p className="pt-3 text-center text-sm leading-snug text-heading-gray opacity-70">{explainer}</p>

      <div className="mt-5 flex flex-col divide-y divide-rule-default border-t border-rule-default">
        <DetailRow label={t('amount')} value={amountText} sub={FIAT_PLACEHOLDER} testId="approve-amount" />
        <DetailRow
          label={t('to')}
          value={truncateAddress(evmAddress)}
          sub={t('yourDepositAddress')}
          testId="approve-to"
        />
        <DetailRow label={t('network')} value={t('ethereumSepolia')} />
        {bridgeFeeText && <DetailRow label={t('bridgeFee')} value={bridgeFeeText} testId="approve-bridge-fee" />}
      </div>

      <div className="mt-6">
        <h3 className="font-heading text-lg font-bold text-heading-gray">{t('steps')}</h3>
        <div className="mt-4 flex flex-col">
          <StepRow
            title={method === 'address' ? t('depositStepWaitingForTransfer') : t('depositStepWaitingForApproval')}
            subtitle={method === 'address' ? undefined : t('depositStepWaitingForApprovalBody', { wallet })}
            state={confirming || detected ? 'complete' : 'active'}
          />
          <StepRow
            title={t('depositStepConfirmingOnSepolia')}
            state={detected ? 'complete' : confirming ? 'active' : 'pending'}
            isLast
          />
        </div>
      </div>

      <div className="pt-8">
        <Button
          title={primaryTitle}
          variant={ButtonVariant.Primary}
          onClick={onPrimary}
          disabled={detected}
          data-testid="approve-primary"
          className="w-full max-w-none rounded-full text-base font-semibold"
        />
        <button
          type="button"
          data-testid="approve-cancel"
          onClick={() => {
            hapticLight();
            onCancel();
          }}
          className="mt-4 w-full text-center font-heading text-base font-bold text-heading-gray"
        >
          {t('cancelRequest')}
        </button>
      </div>
    </div>
  );
};
