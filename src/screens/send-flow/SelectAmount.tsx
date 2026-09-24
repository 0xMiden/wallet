import React from 'react';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { AmountInput } from 'components/AmountInput';
import { Button, ButtonVariant } from 'components/Button';
import { ACCENT_CLASSES, FlowAccent } from 'components/flow/accent';
import { FlowFooter } from 'components/flow/FlowFooter';
import { TokenLogo } from 'components/TokenLogo';
import { AnimatedNumber } from 'components/ui/AnimatedNumber';
import { Avatar } from 'components/ui/Avatar';
import { adaptiveFormatterFor } from 'lib/i18n/numbers';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { PRIMARY_HEX } from 'utils/brand-colors';

import { balanceFormatterFor } from './amount-format';
import { BridgeNetwork } from './bridge-networks';
import { UIToken } from './types';

// Placeholder-circle background before a token/network is chosen. Not a design-system token —
// carried over from the pre-Avatar literal as-is; a later token-cleanup pass maps it to one.
const PLACEHOLDER_BLUE = '#2F6BED';

export interface SelectAmountProps {
  token?: UIToken;
  amount: string;
  isValidAmount: boolean;
  error?: string;
  /** Overrides the amount label (e.g. "Select Amount", "You Pay"). */
  label?: React.ReactNode;
  /** Overrides the Confirm button label in the page variant. */
  confirmTitle?: string;
  showNetworkPill?: boolean;
  showBalanceHelper?: boolean;
  /** Padding classes for the confirm-button footer. The default bottom cushion
   *  clears the floating BottomNav but collapses while the soft keyboard is up
   *  (body's --keyboard-height padding already lifts the layout), keeping the
   *  CTA snug against the keyboard; pass a snugger value when the navbar is
   *  hidden. */
  footerClassName?: string;
  children?: React.ReactNode;
  onAmountChange: (amount: string) => void;
  onSelectToken: () => void;
  /** Required in the default (page) variant, which renders its own Confirm CTA. */
  onConfirm?: () => void;
  /**
   * `embedded` strips the full-screen chrome (network pill, scroll container,
   * Confirm button) so the field can be stacked — the swap screen renders two of
   * these (You Pay / You Receive) under one shared Confirm. The available-balance
   * helper is NOT stripped by `embedded`; it's controlled by `showBalanceHelper`
   * (#461). Defaults to the standalone page layout used by the send flow.
   */
  embedded?: boolean;
  /**
   * The flow this field belongs to. Its action colour draws every affordance the field owns — the
   * token chevron, the network pill and the page variant's Confirm button — so a flow's screen
   * carries one colour throughout (design-system.md, "Action colours").
   */
  accent?: FlowAccent;
  /** Token-logo symbol override (e.g. the DEX `logoSymbol`); defaults to `token.name`. */
  logoSymbol?: string;
  /** Cross-chain deposit — swaps the Miden chip for a destination-network selector. */
  isBridge?: boolean;
  /** Chosen destination network (bridge only). */
  network?: BridgeNetwork;
  /** Token symbol every bridged transfer arrives as (USDC). */
  outputSymbol?: string;
  /** Optional custom header rendered above the amount (e.g. the bridge-deposit "wallet connected · Miden Bridge" title). */
  title?: React.ReactNode;
  /** Show a skeleton in place of the amount while it is being computed (e.g. the swap receive quote). */
  loading?: boolean;
  onSelectNetwork?: () => void;
}

/**
 * Preserve the usual 4dp limit, expanding for tiny balances, then trim trailing zeros.
 *
 * Rounded DOWN, so the "Available" figure is never larger than the amount the
 * form will accept. The native token's cap is `balance - fee reserve`, which
 * makes a long fractional tail the normal case rather than the exception: a
 * 12.345678 balance caps at 12.045677999…, which rounds to "12.0457" — and a
 * user who reads that back into the field is over the cap and rejected, with no
 * Max button to fall back on.
 */
export const SelectAmount: React.FC<SelectAmountProps> = ({
  token,
  amount,
  isValidAmount,
  error,
  label,
  confirmTitle,
  showNetworkPill = true,
  showBalanceHelper = true,
  footerClassName = 'pt-4 pb-[max(0px,calc(6rem-var(--keyboard-height,0px)))]',
  children,
  onAmountChange,
  onSelectToken,
  onConfirm,
  embedded = false,
  accent = 'brand',
  logoSymbol,
  isBridge = false,
  network,
  outputSymbol,
  title,
  loading,
  onSelectNetwork
}) => {
  const { t } = useTranslation();
  const accentClasses = ACCENT_CLASSES[accent];

  const availableFiat = token ? token.balance * token.fiatPrice : 0;
  const formatAvailableFiat = adaptiveFormatterFor(availableFiat);
  // An amount typed here is converted to base units with `token.decimals`. When
  // those decimals are the unknown-token placeholder's guess, that conversion
  // does not mean what the user thinks: "1" becomes 10^6 base units for a faucet
  // that may actually count in 10^18, so the transfer that leaves the wallet is
  // a different quantity from the one on screen. There is no honest way to
  // denominate a transfer in a unit we cannot read, so the flow stops here
  // rather than at the confirmation.
  const scaleIsKnown = token === undefined || token.scaleIsKnown;
  const canProceed = !!token && scaleIsKnown && isValidAmount && (!isBridge || !!network);

  const tokenSelector = (
    <button
      type="button"
      data-testid="send-token-selector"
      onClick={() => {
        hapticLight();
        onSelectToken();
      }}
      className="flex items-center gap-1.25 cursor-pointer rounded-full bg-input-bg px-3 py-2"
    >
      {token ? (
        <TokenLogo symbol={logoSymbol ?? token.name} size="md" />
      ) : embedded ? (
        <Avatar size={36} icon={<span className="text-lg font-bold">$</span>} color={PLACEHOLDER_BLUE} />
      ) : null}
      <span className="font-heading text-2xl font-bold text-ink">{token ? token.name : t('selectAToken')}</span>
      <Icon name={IconName.ChevronDown} size="sm" className={accentClasses.text} fill="currentColor" />
    </button>
  );

  // Cross-chain: a token row connected to a destination-network row, so it
  // reads as "send <token> → arrives as <outputSymbol> on <network>".
  const bridgeSelector = (
    <div className="flex flex-col">
      <button
        type="button"
        data-testid="send-token-selector"
        onClick={() => {
          hapticLight();
          onSelectToken();
        }}
        className="flex items-center gap-3 text-left"
      >
        {token ? (
          <TokenLogo symbol={logoSymbol ?? token.name} size="md" />
        ) : (
          <Avatar size={36} icon={<span className="text-lg font-bold">$</span>} color={PRIMARY_HEX} />
        )}
        <span className="font-heading text-2xl font-bold text-ink">{token ? token.name : t('selectAToken')}</span>
        <Icon name={IconName.ChevronRightLucide} size="sm" className={accentClasses.text} />
      </button>

      {/* Connector aligning the two circle icons */}
      <div className="my-1 ml-4.25 h-4 w-0.5 bg-grey-300" />

      <button
        type="button"
        onClick={() => {
          hapticLight();
          onSelectNetwork?.();
        }}
        className="flex items-start gap-3 text-left"
      >
        <Avatar
          size={36}
          icon={<Icon name={IconName.Globe} size="sm" className={ACCENT_CLASSES.brand.on} fill="currentColor" />}
          color={PRIMARY_HEX}
        />
        <div className="flex flex-col">
          <span className="font-heading text-2xl font-bold text-gray flex items-center gap-1">
            {network ? (
              <>
                <span className="text-gray">{t('network')}</span>
                <span>{network.name}</span>
              </>
            ) : (
              t('selectNetwork')
            )}
            <Icon name={IconName.ChevronRightLucide} size="sm" className={accentClasses.text} />
          </span>
          {network && (
            <span className="text-xs text-text-muted">
              {t('receiveOnArrivesAs', { network: network.name, symbol: outputSymbol })}
            </span>
          )}
        </div>
      </button>
    </div>
  );

  let helper: React.ReactNode = null;
  if (token && showBalanceHelper) {
    // Built once per render, not per frame: `token` is only known here, inside the branch.
    const formatAvailableBalance = balanceFormatterFor(token.balance);
    helper = (
      <>
        <span className="font-heading text-gray text-base font-bold">
          {/* Same guessed scale as the amount above — quoting a spendable
              balance from it would be inviting the user to act on a number the
              wallet cannot stand behind. */}
          {/* Keyed by token, so a different token lands its own balance instead of counting from the
              last token's; a new balance for the same token still counts. */}
          {scaleIsKnown ? (
            <AnimatedNumber
              key={token.id}
              value={token.balance}
              format={value => `${t('available')} ${formatAvailableBalance(value)} ${token.name}`}
            />
          ) : (
            t('unknownTokenScale')
          )}
        </span>
        {/* Only show the fiat approximation when we actually have a price — swap
            DEX tokens carry no fiatPrice, so a "$0.00" line would be misleading. */}
        {scaleIsKnown && token.fiatPrice > 0 && (
          <AnimatedNumber
            key={token.id}
            className="font-heading text-gray text-base font-bold"
            value={availableFiat}
            format={value => t('approxFiatValue', { value: `$${formatAvailableFiat(value)}` })}
          />
        )}
      </>
    );
  }

  const amountField = (
    <AmountInput
      label={label ?? (title ? undefined : t('selectAmount'))}
      value={amount}
      invalid={!!error}
      error={error && (amount || error !== 'invalidAmount') ? t(error) : undefined}
      // The helper (available balance) is controlled by `showBalanceHelper`, not
      // by `embedded`: the swap "You Pay" field is embedded but must still show
      // how much is spendable (#461). Embedded callers that don't want it (e.g.
      // the swap "You Receive" field) pass showBalanceHelper={false}.
      helper={helper}
      tokenSelector={isBridge ? bridgeSelector : tokenSelector}
      accent={accent}
      showDivider={!!amount && !!token}
      data-testid="send-amount-input"
      loading={loading}
      onValueChange={(value, _name, values) => onAmountChange(values?.formatted || value || '')}
    />
  );

  if (embedded) {
    return amountField;
  }

  return (
    <div className={clsx('flex flex-col h-full min-h-0 bg-app-bg', isMobile() ? 'px-8' : 'px-6')}>
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar pt-10">
        {title}
        {showNetworkPill && !isBridge && (
          <span
            className={clsx(
              'self-start text-xs font-semibold px-3 py-1 rounded-full mb-3',
              accentClasses.tint,
              accentClasses.ink
            )}
          >
            {t('miden')}
          </span>
        )}
        {amountField}
        {children}
      </div>

      <FlowFooter className={footerClassName}>
        <Button
          title={confirmTitle ?? t('confirm')}
          variant={ButtonVariant.Primary}
          accent={accent}
          onClick={onConfirm}
          // `onConfirm` is optional (the embedded variant omits it and returns
          // early above), so in this page variant a missing handler disables
          // the CTA rather than rendering a live-but-dead button.
          disabled={!canProceed || !onConfirm}
          data-testid="send-amount-confirm"
          className="w-full max-w-none"
        />
      </FlowFooter>
    </div>
  );
};
