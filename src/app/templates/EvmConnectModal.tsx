import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { App as CapApp } from '@capacitor/app';
import { useTranslation } from 'react-i18next';
import { QRCode as QRCodeSvg } from 'react-qr-svg';

import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import { Button } from 'lib/ui/button';
import { hapticLight, hapticMedium } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import { buildNativeLink, buildUniversalLink, getChain, POPULAR_WALLETS, useWcStore } from 'lib/walletconnect';

interface EvmConnectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function shortenAddress(addr: string): string {
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function openExternal(url: string): void {
  if (typeof window === 'undefined') return;
  window.location.href = url;
}

export const EvmConnectModal: React.FC<EvmConnectModalProps> = ({ open, onOpenChange }) => {
  const { t } = useTranslation();
  const status = useWcStore(s => s.status);
  const uri = useWcStore(s => s.uri);
  const address = useWcStore(s => s.address);
  const chainId = useWcStore(s => s.chainId);
  const error = useWcStore(s => s.error);
  const connect = useWcStore(s => s.connect);
  const disconnect = useWcStore(s => s.disconnect);
  const hydrate = useWcStore(s => s.hydrate);

  const [copied, setCopied] = useState(false);
  const mobile = isMobile();

  useEffect(() => {
    if (!open) return;
    hydrate().catch(err => console.error('[EvmConnectModal] hydrate failed', err));
  }, [open, hydrate]);

  useEffect(() => {
    if (!open) return;
    if (status === 'idle') {
      connect().catch(err => console.error('[EvmConnectModal] connect failed', err));
    }
  }, [open, status, connect]);

  // Re-hydrate from the provider when the app returns to the foreground —
  // covers the case where iOS killed the relay WebSocket while the user
  // was approving in MetaMask, so the `connect` event never reached us.
  useEffect(() => {
    if (!open || !isMobile()) return;
    let cancelled = false;
    const promise = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive && !cancelled) {
        hydrate().catch(err => console.error('[EvmConnectModal] re-hydrate failed', err));
      }
    });
    return () => {
      cancelled = true;
      promise.then(handle => handle.remove()).catch(() => {});
    };
  }, [open, hydrate]);

  const handleCopyUri = useCallback(() => {
    if (!uri) return;
    hapticLight();
    navigator.clipboard.writeText(uri);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [uri]);

  const handleOpenWallet = useCallback(
    (walletId: string) => {
      if (!uri) return;
      const wallet = POPULAR_WALLETS.find(w => w.id === walletId);
      if (!wallet) return;
      hapticMedium();
      const link = mobile ? buildNativeLink(wallet, uri) : buildUniversalLink(wallet, uri);
      openExternal(link);
    },
    [uri, mobile]
  );

  const handleDisconnect = useCallback(() => {
    hapticMedium();
    disconnect().finally(() => onOpenChange(false));
  }, [disconnect, onOpenChange]);

  const chain = useMemo(() => (chainId !== null ? getChain(chainId) : undefined), [chainId]);

  const showConnected = status === 'connected';
  const showUri = (status === 'connecting' || status === 'idle') && !!uri;
  const showSpinner = !showConnected && !showUri;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="pb-6">
        <DrawerHeader>
          <DrawerTitle>
            {showConnected ? t('evmWalletConnected') : mobile ? t('openInYourWallet') : t('scanWithYourWallet')}
          </DrawerTitle>
          <DrawerDescription>
            {showConnected
              ? t('evmWalletConnectedDescription')
              : mobile
                ? t('openInYourWalletDescription')
                : t('scanWithYourWalletDescription')}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex flex-col gap-4 px-4">
          {error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500" role="alert">
              {error}
            </div>
          )}

          {showSpinner && (
            <div className="flex items-center justify-center py-12 text-sm text-grey-500">{t('preparing')}</div>
          )}

          {showUri && !showConnected && mobile && (
            <div className="flex flex-col gap-2">
              {POPULAR_WALLETS.map(w => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => handleOpenWallet(w.id)}
                  className="flex items-center justify-between rounded-lg border border-grey-100 bg-white px-4 py-3 text-left text-sm font-medium text-heading-gray hover:bg-grey-50 active:bg-grey-100 transition"
                >
                  <span>{w.name}</span>
                  <span className="text-grey-400">›</span>
                </button>
              ))}
            </div>
          )}

          {showUri && !showConnected && !mobile && (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="rounded-md bg-pure-white p-3">
                <QRCodeSvg value={uri} style={{ width: 220, height: 220 }} bgColor="#FFFFFF" fgColor="#000000" level="M" />
              </div>
            </div>
          )}

          {showConnected && (
            <div className="flex flex-col gap-2 rounded-lg bg-grey-50 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('address')}</span>
                <span className="font-medium text-heading-gray">{address ? shortenAddress(address) : '…'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-grey-500">{t('network')}</span>
                <span className="font-medium text-heading-gray">
                  {chain?.name ?? (chainId !== null ? `Chain ${chainId}` : '…')}
                </span>
              </div>
            </div>
          )}

          {showUri && !showConnected && (
            <Button variant="secondary" size="lg" onClick={handleCopyUri} className="w-full">
              {copied ? t('copied') : t('copyConnectionLink')}
            </Button>
          )}

          {showConnected && (
            <Button variant="destructive" size="lg" onClick={handleDisconnect} className="w-full">
              {t('disconnect')}
            </Button>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};

export default EvmConnectModal;
