import React, { useEffect, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { NetworkChip } from 'components/NetworkChip';
import { TokenAmountInput } from 'components/TokenAmountInput';
import { TokenLogo } from 'components/TokenLogo';
import { TokenUsdValue } from 'components/TokenUsdValue';
import { AnimatedNumber } from 'components/ui';
import { Card } from 'components/ui/Card';
import { Notice } from 'components/ui/Notice';
import { useMotion } from 'lib/animation';
import { durations } from 'lib/animation/durations';
import { easings } from 'lib/animation/easings';
import { balanceLowerBound } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import { midenTokenLabel } from 'lib/remote-config/token-labels';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import type { UiEvidenceInput } from 'lib/telemetry/ui-producer-diagnostics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import { isUserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { truncateAddress } from 'utils/string';

import { balanceFormatterFor, formatBalance } from './amount-format';
import { AmountShortcuts } from './AmountShortcuts';
import { getBridgeNetwork, SendNetworkId } from './bridge-networks';
import { SendStepLayout } from './SendStepLayout';
import { UIToken } from './types';

export interface SendAmountProps {
  /** The token with its spendable balance (the native token's fee reserve already taken off). */
  token?: UIToken;
  amount: string;
  isValidAmount: boolean;
  /** Untranslated error key from the send form. */
  error?: string;
  errorDiagnostics?: UiEvidenceInput;
  /** The values of the error copy's placeholders. */
  errorValues?: Record<string, string>;
  recipientAddress: string;
  /** Keeps Max on screen but inert, while the token has no cap to fill it with. */
  maxDisabled?: boolean;
  /** Says Send is still checking a token it holds back from new sends until the Testnet document arrives. */
  tokenHeld?: boolean;
  /** Saved contact name for the recipient, shown instead of the address. */
  recipientName?: string;
  network?: SendNetworkId;
  onAmountChange: (amount: string) => void;
  onSelectToken: () => void;
  /** Opens Receive, offered when the account has no MIDEN for the fee. */
  onReceive: () => void;
  onBack: () => void;
  onConfirm: () => void;
}

/**
 * The send flow's amount step. The amount is the step's large input, under the
 * title like the recipient address. One card below it holds what the amount is
 * made of: the token (with its available balance and Max) and where it goes.
 */
export const SendAmount: React.FC<SendAmountProps> = ({
  token,
  amount,
  isValidAmount,
  error,
  errorValues,
  errorDiagnostics,
  recipientAddress,
  maxDisabled,
  tokenHeld,
  recipientName,
  network,
  onAmountChange,
  onSelectToken,
  onReceive,
  onBack,
  onConfirm
}) => {
  const { t } = useTranslation();
  const [shortcutSelection, setShortcutSelection] = useState(0);
  // The field shows the keystroke at once. A later `amount` from the form replaces it,
  // including Max and a restored draft.
  const [draft, setDraft] = useState(amount);
  useEffect(() => {
    setDraft(amount);
  }, [amount]);
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const transition = useMotion({ duration: durations.normal, ease: easings.easeOutCubic });

  // A decimals guess converts the typed amount into the wrong base units, so
  // an unknown-scale token can't be sent (see SelectAmount).
  const scaleIsKnown = token === undefined || token.scaleIsKnown;
  const canProceed = !!token && scaleIsKnown && isValidAmount;
  // Built once per render, not per frame; harmless when `token` is undefined since it is only
  // read from the `{token && ...}` branch below.
  const formatAvailableBalance = balanceFormatterFor(token?.balance ?? 0);

  // The missing-fee shortfall is about the account, not the typed number, so it
  // gets a notice with a way out instead of turning the amount red. An empty
  // field isn't an invalid amount yet.
  const feeShortfall = error === 'insufficientFeeAsset';
  const amountError =
    error && !feeShortfall && (amount || error !== 'invalidAmount') ? t(error, errorValues) : undefined;
  useUserVisibleError(feeShortfall ? 'insufficientFeeAsset' : null, 'notice');
  useUserVisibleError(token && !scaleIsKnown ? 'unknownTokenScale' : null, 'inline');

  const bridgeNetwork = network && network !== 'miden' ? getBridgeNetwork(network) : undefined;

  return (
    <SendStepLayout
      title={t('enterAmount')}
      onBack={onBack}
      footer={
        <Button
          title={t('continue')}
          variant={ButtonVariant.Primary}
          accent="send"
          onClick={onConfirm}
          disabled={!canProceed}
          data-testid="send-amount-confirm"
          className="w-full max-w-none"
        />
      }
    >
      <TokenAmountInput
        assetId={token?.id ?? ''}
        symbol={token?.name ?? ''}
        decimals={token?.decimals ?? 0}
        decimalsLimit={token ? token.decimals : 6}
        scaleIsKnown={!!token?.scaleIsKnown}
        value={draft}
        tokenIntentKey={shortcutSelection}
        invalid={!!amountError}
        error={amountError}
        errorId={isUserErrorId(error) ? error : null}
        errorDiagnostics={errorDiagnostics}
        showDivider={false}
        data-testid="send-amount-input"
        onValueChange={value => {
          const next = value || '';
          setDraft(next);
          onAmountChange(next);
        }}
      />

      {token && (
        <AmountShortcuts
          balance={token.balance}
          decimals={token.decimals}
          scaleIsKnown={scaleIsKnown}
          maxAmount={formatBalance(balanceLowerBound(token.balance, token.decimals))}
          onAmountChange={value => {
            setShortcutSelection(selection => selection + 1);
            onAmountChange(value);
          }}
          disabled={maxDisabled}
          testIdPrefix="send-amount"
          className="text-accent-send-ink"
        />
      )}

      <Card surface="outline" padding="none" className="mt-8">
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            type="button"
            data-testid="send-token-selector"
            onClick={() => {
              hapticLight();
              onSelectToken();
            }}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            {token ? (
              <TokenLogo faucetId={token.id} size="md" />
            ) : (
              <span className="h-9 w-9 shrink-0 rounded-full bg-gray-100" aria-hidden="true" />
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-1 font-heading text-lg leading-tight font-bold text-ink">
                {token ? midenTokenLabel(bridgeConfig, token.id, token.name) : t('selectAToken')}
                <Icon name={IconName.ChevronDown} size="xs" className="text-accent-send" fill="currentColor" />
              </span>
              {token && (
                <span className="text-sm text-text-muted" data-testid="send-amount-available">
                  {/* Keyed by token: a different token lands its balance, not a count from the last one. */}
                  {scaleIsKnown ? (
                    <AnimatedNumber
                      key={token.id}
                      value={token.balance}
                      format={value => `${t('available')} ${formatAvailableBalance(value)}`}
                    />
                  ) : (
                    t('unknownTokenScale')
                  )}
                  {scaleIsKnown && (
                    <TokenUsdValue
                      amount={token.balance}
                      faucetId={token.id}
                      symbol={token.name}
                      className="block text-caption text-muted"
                    />
                  )}
                </span>
              )}
            </span>
          </button>
        </div>

        <div className="mx-4 border-t border-rule-default" />

        <div className="flex items-center gap-3 px-4 py-3">
          <span className="text-sm text-text-muted">{t('to')}</span>
          <span
            data-testid="send-amount-recipient"
            className="min-w-0 flex-1 truncate font-heading text-base font-bold text-ink"
          >
            {recipientName ?? truncateAddress(recipientAddress)}
          </span>
          {bridgeNetwork ? (
            <NetworkChip kind="ethereum" network={bridgeNetwork.id} label={bridgeNetwork.name} />
          ) : (
            <NetworkChip kind="miden" label={t('miden')} />
          )}
        </div>
      </Card>

      {tokenHeld && (
        <Notice
          tone="warning"
          icon={<Icon name={IconName.Information} size="xs" fill="currentColor" />}
          className="mt-4"
          data-testid="send-amount-held-notice"
        >
          {t('sendTokenAvailabilityChecking')}
        </Notice>
      )}

      <AnimatePresence initial={false}>
        {feeShortfall && (
          <motion.div
            key="fee-notice"
            className="overflow-hidden"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={transition}
          >
            <div className="pt-4">
              <Card padding="row" data-testid="send-fee-notice" className="flex items-start gap-3">
                <Icon
                  name={IconName.InformationFill}
                  size="xs"
                  fill="currentColor"
                  className="mt-0.5 shrink-0 text-ink"
                />
                <div className="flex flex-col items-start gap-1">
                  <span className="text-sm text-ink">{t('insufficientFeeAsset')}</span>
                  <button
                    type="button"
                    data-testid="send-fee-notice-receive"
                    onClick={() => {
                      hapticLight();
                      onReceive();
                    }}
                    className="flex items-center gap-0.5 font-heading text-sm font-bold text-accent-send-ink"
                  >
                    {t('receive')}
                    <Icon name={IconName.ChevronRightLucide} size="xs" className="text-accent-send-ink" />
                  </button>
                </div>
              </Card>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SendStepLayout>
  );
};
