import React from 'react';

import classNames from 'clsx';
import CurrencyInput from 'react-currency-input-field';

import { Icon, IconName } from 'app/icons/v2';
import { Button, ButtonVariant } from 'components/Button';
import { ScreenHeader } from 'components/ScreenHeader';
import { TokenLogo } from 'components/TokenLogo';

import { shortenAddress } from './shared';

export type BridgeRoute = 'epoch' | 'agglayer';

interface EvmBridgeDepositFormProps {
  evmAddress: string;
  amount: string;
  tokenSymbol: string;
  subtitle: string;
  route: BridgeRoute;
  quoteHint: string | null;
  statusMessage: string | null;
  error: string | null;
  balanceError: string | null;
  maxDisabled: boolean;
  continueLabel: string;
  continueDisabled: boolean;
  closeLabel: string;
  disconnectLabel: string;
  onAmountChange: (value?: string) => void;
  onMax: () => void;
  onRouteChange: (route: BridgeRoute) => void;
  onContinue: () => void;
  onDisconnect: () => void;
  onClose: () => void;
}

export const EvmBridgeDepositForm: React.FC<EvmBridgeDepositFormProps> = ({
  evmAddress,
  amount,
  tokenSymbol,
  subtitle,
  route,
  quoteHint,
  statusMessage,
  error,
  balanceError,
  maxDisabled,
  continueLabel,
  continueDisabled,
  closeLabel,
  disconnectLabel,
  onAmountChange,
  onMax,
  onRouteChange,
  onContinue,
  onDisconnect,
  onClose
}) => (
  <div className="flex h-full min-h-0 flex-col bg-app-bg text-heading-gray">
    <div className="shrink-0 px-4">
      <ScreenHeader title="Miden Bridge" closeLabel={closeLabel} onClose={onClose} />
    </div>
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-4">
      <div className="pt-4">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border-light bg-white px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-text-tertiary-token">Connected wallet</p>
            <p className="truncate text-sm font-semibold text-heading-gray">{shortenAddress(evmAddress)}</p>
          </div>
          <button
            type="button"
            onClick={onDisconnect}
            className="shrink-0 rounded-xl border border-border-button px-3 py-2 text-sm font-semibold text-heading-gray"
          >
            {disconnectLabel}
          </button>
        </div>

        <div className="mt-4 text-center">
          <p className="text-sm font-semibold text-heading-gray">Choose Amount</p>
          <CurrencyInput
            value={amount}
            onValueChange={onAmountChange}
            inputMode="decimal"
            placeholder="0"
            aria-label="Bridge amount"
            className={classNames(
              'mt-5 h-18 w-full bg-transparent p-0 text-center text-[64px] font-semibold leading-none outline-none placeholder:text-grey-300',
              amount ? 'text-heading-gray' : 'text-grey-300',
              amountTextSize(amount)
            )}
            disableGroupSeparators
            decimalSeparator="."
            decimalsLimit={6}
            allowNegativeValue={false}
            maxLength={16}
          />
          <p className="mt-2 text-xs text-text-tertiary-token">{subtitle}</p>
        </div>

        <div className="mt-2 flex items-center justify-between rounded-10 bg-surface-interactive px-5 py-4">
          <div className="flex flex-1 items-center justify-center gap-3">
            <TokenLogo symbol={tokenSymbol} size="sm" />
            <span className="text-sm font-semibold text-black">{tokenSymbol}</span>
            <Icon name={IconName.ChevronDown} size="xs" className="text-heading-gray" />
          </div>
          <button
            type="button"
            onClick={onMax}
            disabled={maxDisabled}
            className="rounded-xl bg-accent-primary px-4 py-2 text-sm font-bold text-pure-white disabled:opacity-50"
          >
            MAX
          </button>
        </div>

        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold text-heading-gray">From chain</p>
          <div className="flex items-center gap-3 rounded-2xl bg-surface-interactive px-4 py-4">
            <TokenLogo symbol="ETH" size="sm" />
            <span className="text-base font-medium text-heading-gray">Sepolia</span>
          </div>
        </div>

        <div className="mt-6">
          <p className="mb-2 text-sm font-semibold text-heading-gray">Choose bridge option</p>
          <div className="flex flex-col gap-4">
            <RouteOption
              active={route === 'epoch'}
              title="Instant"
              description="In a few minutes"
              onClick={() => onRouteChange('epoch')}
            />
            <RouteOption
              active={route === 'agglayer'}
              title="Slow"
              description="Est. 30-90 min"
              onClick={() => onRouteChange('agglayer')}
            />
          </div>
        </div>

        {quoteHint && <p className="mt-4 text-center text-sm font-semibold text-heading-gray">{quoteHint}</p>}
        {statusMessage && <p className="mt-4 text-center text-sm text-text-tertiary-token">{statusMessage}</p>}
        {error && (
          <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500" role="alert">
            {error}
          </div>
        )}
        {balanceError && (
          <div className="mt-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500" role="alert">
            {balanceError}
          </div>
        )}

        <div className="pt-4">
          <Button variant={ButtonVariant.Primary} onClick={onContinue} disabled={continueDisabled} className="w-full">
            {continueLabel}
          </Button>
        </div>
      </div>
    </div>
  </div>
);

function amountTextSize(value: string): string {
  const len = value.length || 4;
  if (len >= 13) return 'text-3xl';
  if (len >= 10) return 'text-4xl';
  if (len >= 7) return 'text-5xl';
  return 'text-6xl';
}

interface RouteOptionProps {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}

const RouteOption: React.FC<RouteOptionProps> = ({ active, title, description, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={classNames(
      'flex w-full items-center rounded-xl border p-3 text-left',
      active
        ? 'border-accent-primary bg-accent-primary text-pure-white'
        : 'border-border-light bg-white text-heading-gray'
    )}
  >
    <span className="min-w-0">
      <span className={classNames('block text-base font-bold leading-none', active ? 'text-pure-white' : 'text-black')}>
        {title}
      </span>
      <span className={classNames('text-sm leading-none', active ? 'text-pure-white' : 'text-text-tertiary-token')}>
        {description}
      </span>
    </span>
  </button>
);
