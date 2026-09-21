import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { NetworkChip } from 'components/NetworkChip';
import { QRCode, type QRCodeHandle } from 'components/QRCode';
import { CopyButton } from 'components/ui/CopyButton';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { isBridgeDepositEnabled } from 'lib/feature-flags';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { isExtension, isMobile } from 'lib/platform';
import { useClipboardCopy } from 'lib/ui/useClipboardCopy';
import { cn } from 'lib/ui/util';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { truncateAddress } from 'utils/string';

interface AddressTabProps {
  address: string;
  onBridgeDeposit: () => void;
}

const QR_FILE_NAME = 'miden-address.png';
/** Resolution of the shared QR image; on screen the QR scales to the room the layout leaves. */
const QR_EXPORT_SIZE = 300;

/** Reads a Blob as raw base64 (without the `data:*;base64,` prefix) for Capacitor Filesystem. */
const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result.slice(result.indexOf(',') + 1));
      } else {
        reject(new Error('Unexpected FileReader result'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read QR image'));
    reader.readAsDataURL(blob);
  });

export const AddressTab: React.FC<AddressTabProps> = ({ address, onBridgeDeposit }) => {
  const { t } = useTranslation();
  const networkKey = getTestNetworkNameKey();
  const network = networkKey ? t(networkKey) : null;
  // The share fallback copies through the same hook as the page's copy control: one clipboard
  // path, and it catches a rejected write.
  const { copy: copyAddress } = useClipboardCopy(address);
  const [evmOpen, setEvmOpen] = useState(false);
  const { address: evmAddress, connected: evmConnected } = useEvmWalletConnection();
  const qrRef = useRef<QRCodeHandle>(null);

  const openBridgeDeposit = useCallback(() => {
    onBridgeDeposit();
  }, [onBridgeDeposit]);

  // ListRow fires the tap haptic for both actions.
  const handleOpenEvm = useCallback(() => {
    if (evmConnected && evmAddress) {
      openBridgeDeposit();
      return;
    }
    setEvmOpen(true);
  }, [evmAddress, evmConnected, openBridgeDeposit]);

  useEffect(() => {
    if (!evmOpen || !evmConnected || !evmAddress) return;
    setEvmOpen(false);
    openBridgeDeposit();
  }, [evmAddress, evmConnected, evmOpen, openBridgeDeposit]);

  // The shared text names the network (#875) so a pasted address never loses
  // its context. The QR image carries the same caption (see `caption` below).
  // Mainnet has no test network to name, so it shares the bare address.
  const shareText = network ? t('shareAddressText', { network, address }) : address;

  const handleShare = useCallback(async () => {
    let qrBlob: Blob | null = null;
    try {
      qrBlob = (await qrRef.current?.getImageBlob()) ?? null;
    } catch (e) {
      console.warn('[Receive] failed to render QR image for share:', e);
    }

    try {
      if (isMobile()) {
        if (qrBlob) {
          const { uri } = await Filesystem.writeFile({
            path: QR_FILE_NAME,
            data: await blobToBase64(qrBlob),
            directory: Directory.Cache
          });
          await Share.share({ text: shareText, files: [uri], dialogTitle: t('receive') });
        } else {
          await Share.share({ text: shareText, dialogTitle: t('receive') });
        }
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.share) {
        if (qrBlob && typeof navigator.canShare === 'function') {
          const file = new File([qrBlob], QR_FILE_NAME, { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], text: shareText });
            return;
          }
        }
        await navigator.share({ text: shareText });
        return;
      }
    } catch (e) {
      console.warn('[Receive] share dismissed:', e);
    }
    await copyAddress();
  }, [copyAddress, shareText, t]);

  const showCrossChain = !isExtension() && isBridgeDepositEnabled();

  return (
    // Last-resort scroll only: the column below is laid out to fit between the top action bar and
    // the tab bar on every supported height (the QR takes whatever height is left), and scrolls
    // only when even the smallest QR does not fit.
    <div
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
      style={{ touchAction: 'pan-y' }}
      data-testid="receive-page"
    >
      <div
        className={cn(
          'mx-auto flex min-h-full w-full max-w-150 flex-col px-4 pt-4',
          // Clears the tab bar that overlays the page (TabLayout): 57px docked on an iPhone, 64px
          // floating elsewhere, plus the 16px gutter.
          isMobile() ? 'pb-18' : 'pb-20'
        )}
      >
        {/* Hidden, untruncated address for E2E DOM fallback (visible address below is truncated). */}
        <span data-testid="receive-address-full" className="sr-only">
          {address}
        </span>

        {/* The QR block: one centred column. */}
        <div data-testid="receive-qr-block" className="flex flex-1 flex-col items-center gap-3">
          {/* The QR takes the height the rest of the page leaves (never under 160px), square and
              capped at 288px. The frame is sized off the slot's flexed height through an absolute
              box: a size container would be simpler, but Chrome resolves `cqh` to 0 in a slot whose
              height comes from flexing. */}
          <div data-testid="receive-qr-slot" className="relative min-h-40 w-full flex-1">
            <div className="absolute inset-0 flex items-center justify-center">
              <div data-testid="receive-qr-frame" className="aspect-square h-full max-h-72 max-w-full">
                <QRCode
                  ref={qrRef}
                  address={address}
                  size={QR_EXPORT_SIZE}
                  // The page names the network in the chip below; the shared image still carries it.
                  caption={network ? t('qrNetworkCaption', { network }) : undefined}
                />
              </div>
            </div>
          </div>
          {network && (
            <NetworkChip kind="miden" label={t('qrNetworkCaption', { network })} data-testid="receive-network" />
          )}
          <CopyButton
            text={address}
            data-testid="receive-copy-address"
            className="flex h-11 w-full items-center justify-center rounded-full bg-fill px-4 text-ink transition-colors hover:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            {copied => (
              <span className="flex min-w-0 items-center gap-2 font-heading text-base leading-5 font-bold">
                <Icon
                  name={copied ? IconName.Checkmark : IconName.CopyNew}
                  size="xs"
                  fill={copied ? 'currentColor' : undefined}
                  className={cn('shrink-0', copied ? 'text-positive-ink' : 'text-muted')}
                />
                <span className="truncate">{copied ? t('copied') : truncateAddress(address, false, 16, 8)}</span>
              </span>
            )}
          </CopyButton>
        </div>

        <div className="mt-5 flex shrink-0 flex-col gap-3">
          {/* Test-funds warning sits before the share and bridge actions:
              the funding decision point named in #875. */}
          {network && (
            <Notice
              tone="warning"
              icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
              data-testid="receive-test-funds-warning"
            >
              {t('receiveTestFundsBody', { network })}
            </Notice>
          )}
          <ListGroup data-testid="receive-actions">
            <ListRow
              icon={<Icon name={IconName.Share} size="xs" />}
              title={t('share')}
              onClick={() => void handleShare()}
              data-testid="receive-share"
            />
            {/* WalletConnect is not supported on the extension: the Reown relay
                rejects the extension bundle's auth JWT (WebSocket close 3000), so
                the AppKit connect flow can never complete there. */}
            {showCrossChain && (
              <ListRow
                icon={<Icon name={IconName.CrossChain} size="xs" />}
                title={t('crossChain')}
                // Name the actual source test network, not a bare "Testnet" (#875).
                subtitle={t('crossChainFromNetwork', { network: t('ethereumSepolia') })}
                chevron
                onClick={handleOpenEvm}
                data-testid="receive-cross-chain"
              />
            )}
          </ListGroup>
        </div>
      </div>
      {showCrossChain && <EvmConnectModal open={evmOpen} onOpenChange={setEvmOpen} />}
    </div>
  );
};
