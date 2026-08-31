import React, { useCallback, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';
import { parseUnits } from 'viem';

import { Icon, IconName } from 'app/icons/v2';
import { DepositMethodDrawer } from 'app/pages/Receive/DepositMethodDrawer';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { Button, ButtonVariant } from 'components/Button';
import { TokenLogo } from 'components/TokenLogo';
import { ActivityRow, type ActivityStatusTone } from 'components/ui/ActivityRow';
import {
  DEPOSIT_TOKEN_IDS,
  formatBalance,
  getDepositToken,
  useDepositAddressStore,
  type DepositEvmTx,
  type DepositTokenId
} from 'lib/deposit-bridge';
import { isBridgeDepositEnabled } from 'lib/feature-flags';
import { openExternalUrl } from 'lib/mobile/external-browser';
import { hapticLight } from 'lib/mobile/haptics';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import { isExtension } from 'lib/platform';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { SelectAmount } from 'screens/send-flow/SelectAmount';
import type { UIToken } from 'screens/send-flow/types';
import { truncateAddress } from 'utils/string';

interface CrossChainTabProps {
  /** Vault-derived EVM deposit address (`0x…`). */
  evmAddress: string;
  /** The account's Miden address — shown as the bridge destination. */
  midenAddress: string;
  onBridge: (token?: DepositTokenId) => void;
  /** Opens the legacy WalletConnect bridge-deposit flow. */
  onBridgeDeposit: () => void;
}

const SEPOLIA_TX_URL = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Relative timestamp for the activity list; no shared helper exists in the repo yet. */
function useRelativeTime(): (timestampMs: number) => string {
  const { t } = useTranslation();
  return useCallback(
    (timestampMs: number) => {
      const delta = Date.now() - timestampMs;
      if (!Number.isFinite(delta) || delta < MINUTE_MS) return t('justNow');
      if (delta < HOUR_MS) return t('minutesAgo', { value: Math.floor(delta / MINUTE_MS) });
      if (delta < DAY_MS) return t('hoursAgo', { value: Math.floor(delta / HOUR_MS) });
      return t('daysAgo', { value: Math.floor(delta / DAY_MS) });
    },
    [t]
  );
}

const STATUS_TONE: Record<DepositEvmTx['status'], ActivityStatusTone> = {
  confirmed: 'confirmed',
  pending: 'pending',
  failed: 'failed'
};

/** Parse user input into base units; `undefined` for anything unusable. */
function parseAmount(amount: string, decimals: number): bigint | undefined {
  const trimmed = amount.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = parseUnits(trimmed, decimals);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export const CrossChainTab: React.FC<CrossChainTabProps> = ({
  evmAddress,
  midenAddress,
  onBridge,
  onBridgeDeposit
}) => {
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();

  const balances = useDepositAddressStore(s => s.balances);
  const status = useDepositAddressStore(s => s.status);
  const poll = useDepositAddressStore(s => s.poll);
  const recentTxs = useDepositAddressStore(s => s.recentTxs);

  const [token, setToken] = useState<DepositTokenId>('ETH');
  const [amount, setAmount] = useState('');
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);

  const [evmOpen, setEvmOpen] = useState(false);
  const { address: connectedEvmAddress, connected: evmConnected } = useEvmWalletConnection();
  const walletConnectAvailable = !isExtension() && isBridgeDepositEnabled();

  const config = getDepositToken(token);
  const parsedAmount = parseAmount(amount, config.decimals);

  const uiToken: UIToken = {
    id: config.id,
    name: config.symbol,
    decimals: config.decimals,
    balance: 0,
    fiatPrice: 0,
    // Fixed EVM deposit tokens — decimals come from the registry, not a placeholder.
    scaleIsKnown: true
  };

  const handleOpenEvm = useCallback(() => {
    hapticLight();
    if (evmConnected && connectedEvmAddress) {
      onBridgeDeposit();
      return;
    }
    setEvmOpen(true);
  }, [connectedEvmAddress, evmConnected, onBridgeDeposit]);

  useEffect(() => {
    if (!evmOpen || !evmConnected || !connectedEvmAddress) return;
    setEvmOpen(false);
    onBridgeDeposit();
  }, [connectedEvmAddress, evmConnected, evmOpen, onBridgeDeposit]);

  // Hardware/swipe back peels the tab's own sheets before the page-level default.
  useMobileBackHandler(() => {
    if (methodOpen) {
      setMethodOpen(false);
      return true;
    }
    if (tokenPickerOpen) {
      setTokenPickerOpen(false);
      return true;
    }
    return false;
  }, [methodOpen, tokenPickerOpen]);

  /** Tokens whose detected balance clears their dust floor — the persistent bridge entry point. */
  const fundedTokens = useMemo(
    () =>
      DEPOSIT_TOKEN_IDS.filter(id => {
        const raw = balances[id];
        return raw !== null && raw > getDepositToken(id).dustFloor;
      }),
    [balances]
  );

  const handleRetry = useCallback(() => {
    hapticLight();
    void poll();
  }, [poll]);

  const handleOpenTx = useCallback(
    (hash: string) => {
      void openExternalUrl({ url: SEPOLIA_TX_URL(hash), title: t('recentActivity') });
    },
    [t]
  );

  const handleSelectToken = useCallback((next: DepositTokenId) => {
    hapticLight();
    setToken(next);
    setTokenPickerOpen(false);
  }, []);

  const handleBridgeClick = useCallback(() => {
    if (!parsedAmount) return;
    hapticLight();
    setMethodOpen(true);
  }, [parsedAmount]);

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      style={{ touchAction: 'pan-y' }}
      data-testid="receive-cross-chain-page"
    >
      <div className="min-h-full flex flex-col">
        <div className="flex flex-col items-center px-6 pt-4 pb-32">
          {/* Hidden, untruncated address for E2E DOM fallback. */}
          <span data-testid="receive-evm-address-full" className="sr-only">
            {evmAddress}
          </span>
          {/* Destination account, kept in the DOM so the bridge target is unambiguous to E2E. */}
          <span data-testid="receive-cross-chain-destination" className="sr-only">
            {midenAddress}
          </span>

          <div className="flex items-center gap-2 rounded-full bg-gray-50 px-3 py-1.5 mb-6">
            <TokenLogo symbol="ETH" size="sm" />
            <span className="text-xs font-medium text-black">{t('ethereumSepolia')}</span>
          </div>

          <div className="w-full">
            <SelectAmount
              embedded
              token={uiToken}
              amount={amount}
              isValidAmount={!amount.trim() || !!parsedAmount}
              label={t('depositAmountEntryTitle')}
              onAmountChange={setAmount}
              onSelectToken={() => setTokenPickerOpen(true)}
            />
          </div>

          <div className="w-full pt-6">
            <Button
              title={t('bridge')}
              variant={ButtonVariant.Primary}
              disabled={!parsedAmount}
              data-testid="deposit-entry-bridge"
              onClick={handleBridgeClick}
              className="w-full max-w-none rounded-full text-base font-semibold"
            />
          </div>

          <p className="w-full pt-5 text-center text-sm text-heading-gray opacity-70">{t('depositAddressExplainer')}</p>
          <div className="w-full mt-3 flex items-start gap-2 rounded-10 bg-gray-50 px-4 py-3">
            <Icon name={IconName.Warning} size="sm" className="shrink-0 mt-0.5" />
            <p className="text-xs leading-snug text-heading-gray">{t('depositAddressWarning')}</p>
          </div>

          {/* Persistent entry point: current detected balances, not a dismissible prompt. */}
          <div className="w-full pt-6">
            {fundedTokens.length > 0 ? (
              <div className="w-full flex flex-col gap-2">
                {fundedTokens.map(id => {
                  const funded = getDepositToken(id);
                  const raw = balances[id];
                  return (
                    <div
                      key={id}
                      data-testid={`deposit-balance-${id}`}
                      className="w-full flex items-center justify-between rounded-10 bg-gray-50 px-4 py-3"
                    >
                      <div className="flex items-center gap-2">
                        <TokenLogo symbol={funded.symbol} size="sm" />
                        <span className="font-heading text-base font-bold text-heading-gray">
                          {`${formatBalance(raw ?? 0n, funded.decimals)} ${funded.symbol}`}
                        </span>
                      </div>
                      <Button
                        variant={ButtonVariant.Primary}
                        title={t('bridge')}
                        className="w-auto h-9 px-5 text-sm"
                        data-testid={`deposit-bridge-${id}`}
                        onClick={() => onBridge(id)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : status === 'error' ? (
              <div className="w-full flex items-center justify-center gap-3">
                <span className="text-sm text-heading-gray opacity-50">{t('depositBalanceCheckFailed')}</span>
                <button type="button" onClick={handleRetry} className="text-sm font-bold text-accent-primary">
                  {t('retry')}
                </button>
              </div>
            ) : (
              <p className={classNames('w-full text-center text-sm text-heading-gray opacity-50', 'animate-pulse')}>
                {t('depositWaitingForFunds')}
              </p>
            )}
          </div>

          {recentTxs.length > 0 && (
            <div className="w-full pt-6">
              <h3 className="font-heading text-sm font-bold text-heading-gray opacity-50">{t('recentActivity')}</h3>
              <div className="w-full flex flex-col divide-y divide-gray-100">
                {recentTxs.map(tx => (
                  <ActivityRow
                    key={tx.hash}
                    icon={<Icon name={tx.isBridgeOut ? IconName.CrossChain : IconName.Receive} />}
                    iconBg={tx.isBridgeOut ? 'bg-gray-400' : 'bg-receive-green'}
                    title={tx.isBridgeOut ? t('bridgeToMiden') : t('received')}
                    subtitle={truncateAddress(tx.counterparty)}
                    amount={{
                      value: `${tx.isBridgeOut ? '-' : '+'}${formatBalance(tx.amount, tx.decimals)}`,
                      symbol: tx.symbol,
                      direction: tx.isBridgeOut ? 'negative' : 'positive'
                    }}
                    status={
                      tx.status === 'confirmed' ? undefined : { label: t(tx.status), tone: STATUS_TONE[tx.status] }
                    }
                    timestamp={tx.status === 'confirmed' ? relativeTime(tx.timestamp) : undefined}
                    onClick={() => handleOpenTx(tx.hash)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Which token to request from the counterparty wallet — always both options. */}
      <Drawer open={tokenPickerOpen} onOpenChange={setTokenPickerOpen}>
        <DrawerContent className="md:mx-auto md:max-w-md">
          <DrawerHeader>
            <DrawerTitle>{t('depositBridgeSelectAsset')}</DrawerTitle>
          </DrawerHeader>
          <div className="flex flex-col divide-y divide-rule-default px-6 pb-6">
            {DEPOSIT_TOKEN_IDS.map(id => (
              <button
                key={id}
                type="button"
                data-testid={`deposit-entry-token-${id}`}
                onClick={() => handleSelectToken(id)}
                className="flex w-full items-center gap-3 py-4 text-left"
              >
                <TokenLogo symbol={getDepositToken(id).symbol} size="md" />
                <span className="flex-1 font-heading text-base font-bold text-heading-gray">
                  {getDepositToken(id).symbol}
                </span>
                {id === token && (
                  <Icon name={IconName.Checkmark} size="sm" className="text-accent-primary" fill="currentColor" />
                )}
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

      {parsedAmount !== undefined && (
        <DepositMethodDrawer
          open={methodOpen}
          onOpenChange={setMethodOpen}
          token={token}
          amount={parsedAmount}
          evmAddress={evmAddress}
          onConnectWallet={walletConnectAvailable ? handleOpenEvm : undefined}
        />
      )}

      {walletConnectAvailable && <EvmConnectModal open={evmOpen} onOpenChange={setEvmOpen} />}
    </div>
  );
};
