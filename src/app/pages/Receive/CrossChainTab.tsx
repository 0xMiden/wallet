import React, { useCallback, useEffect, useMemo, useState } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import CopyButton from 'app/atoms/CopyButton';
import FormField from 'app/atoms/FormField';
import { Icon, IconName } from 'app/icons/v2';
import { useShareAddress } from 'app/pages/Receive/useShareAddress';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { Button, ButtonVariant } from 'components/Button';
import { QRCode } from 'components/QRCode';
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
import { isExtension } from 'lib/platform';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
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

const QR_FILE_NAME = 'miden-deposit-address.png';

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

export const CrossChainTab: React.FC<CrossChainTabProps> = ({
  evmAddress,
  midenAddress,
  onBridge,
  onBridgeDeposit
}) => {
  const { t } = useTranslation();
  const { fieldRef, copy } = useCopyToClipboard();
  const { qrRef, share } = useShareAddress({ address: evmAddress, fileName: QR_FILE_NAME, onFallbackCopy: copy });
  const relativeTime = useRelativeTime();

  const balances = useDepositAddressStore(s => s.balances);
  const status = useDepositAddressStore(s => s.status);
  const poll = useDepositAddressStore(s => s.poll);
  const recentTxs = useDepositAddressStore(s => s.recentTxs);

  const [evmOpen, setEvmOpen] = useState(false);
  const { address: connectedEvmAddress, connected: evmConnected } = useEvmWalletConnection();
  const walletConnectAvailable = !isExtension() && isBridgeDepositEnabled();

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

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      style={{ touchAction: 'pan-y' }}
      data-testid="receive-cross-chain-page"
    >
      <div className="min-h-full flex flex-col">
        <div className="flex flex-col items-center px-6 pt-4 pb-32">
          <FormField ref={fieldRef} value={evmAddress} style={{ display: 'none' }} />
          {/* Hidden, untruncated address for E2E DOM fallback (visible address below is truncated). */}
          <span data-testid="receive-evm-address-full" className="sr-only">
            {evmAddress}
          </span>
          {/* Destination account, kept in the DOM so the bridge target is unambiguous to E2E. */}
          <span data-testid="receive-cross-chain-destination" className="sr-only">
            {midenAddress}
          </span>

          <div className="flex items-center gap-2 rounded-full bg-gray-50 px-3 py-1.5 mb-4">
            <TokenLogo symbol="ETH" size="sm" />
            <span className="text-xs font-medium text-black">{t('ethereumSepolia')}</span>
          </div>

          <div className="w-full flex flex-col items-center justify-center gap-6">
            <QRCode ref={qrRef} address={evmAddress} payload={evmAddress} size={300} />
            <CopyButton
              text={evmAddress}
              className="w-full rounded-full! text-center py-5 bg-surface-interactive hover:bg-surface-interactive"
            >
              <span className="text-base font-heading font-bold text-heading-gray">
                {truncateAddress(evmAddress, false, 16, 8)}
              </span>
            </CopyButton>
          </div>

          <div className="w-full flex items-center justify-center gap-3 pt-5">
            {DEPOSIT_TOKEN_IDS.map(id => (
              <div key={id} className="flex items-center gap-2 rounded-full bg-gray-50 px-3 py-1.5">
                <TokenLogo symbol={getDepositToken(id).symbol} size="sm" />
                <span className="text-sm font-medium text-black">{getDepositToken(id).symbol}</span>
              </div>
            ))}
          </div>

          <p className="w-full pt-5 text-center text-sm text-heading-gray opacity-70">{t('depositAddressExplainer')}</p>
          <div className="w-full mt-3 flex items-start gap-2 rounded-10 bg-gray-50 px-4 py-3">
            <Icon name={IconName.Warning} size="sm" className="shrink-0 mt-0.5" />
            <p className="text-xs leading-snug text-heading-gray">{t('depositAddressWarning')}</p>
          </div>

          <button type="button" onClick={share} className="flex items-center gap-3 text-accent-primary pt-6">
            <Icon name={IconName.Share} size="md" className="shrink-0" />
            <span className="font-heading text-2xl font-bold leading-none text-heading-gray">{t('share')}</span>
          </button>

          {/* Persistent entry point: current detected balances, not a dismissible prompt. */}
          <div className="w-full pt-6">
            {fundedTokens.length > 0 ? (
              <div className="w-full flex flex-col gap-2">
                {fundedTokens.map(id => {
                  const token = getDepositToken(id);
                  const raw = balances[id];
                  return (
                    <div
                      key={id}
                      data-testid={`deposit-balance-${id}`}
                      className="w-full flex items-center justify-between rounded-10 bg-gray-50 px-4 py-3"
                    >
                      <div className="flex items-center gap-2">
                        <TokenLogo symbol={token.symbol} size="sm" />
                        <span className="font-heading text-base font-bold text-heading-gray">
                          {`${formatBalance(raw ?? 0n, token.decimals)} ${token.symbol}`}
                        </span>
                      </div>
                      <Button
                        variant={ButtonVariant.Primary}
                        title={t('bridge')}
                        className="px-4 py-2 text-sm"
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

          {/* WalletConnect is not supported on the extension: the Reown relay rejects the
              extension bundle's auth JWT (WebSocket close 3000), so the AppKit connect flow
              can never complete there. */}
          {walletConnectAvailable && (
            <button
              type="button"
              data-testid="receive-cross-chain"
              onClick={handleOpenEvm}
              className="pt-8 text-sm font-medium text-accent-primary underline"
            >
              {t('bridgeFromConnectedWallet')}
            </button>
          )}
        </div>
      </div>
      {walletConnectAvailable && <EvmConnectModal open={evmOpen} onOpenChange={setEvmOpen} />}
    </div>
  );
};
