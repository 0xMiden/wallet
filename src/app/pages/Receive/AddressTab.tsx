import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { usePageActive } from 'app/layouts/page-active';
import EvmConnectModal from 'app/templates/EvmConnectModal';
import { NetworkChip } from 'components/NetworkChip';
import { QRCode, type QRCodeHandle, type QRPalette } from 'components/QRCode';
import { CopyButton } from 'components/ui/CopyButton';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { Notice } from 'components/ui/Notice';
import { resolveTransition, tabBarMotion } from 'lib/animation';
import { isBridgeDepositEnabled } from 'lib/feature-flags';
import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';
import { useEvmWalletConnection } from 'lib/walletconnect/useEvmWalletConnection';
import { truncateAddress } from 'utils/string';

interface AddressTabProps {
  address: string;
  onBridgeDeposit: () => void;
}

const QR_FILE_NAME = 'miden-address.png';

/**
 * Tapping the Bread logo in the middle of the QR walks this cycle. It opens on the Receive flow's
 * own green, the colour the rest of the page is painted in, and then runs the other four account
 * card colours. Every one is a palette colour, so the modules never lighten past a scannable QR.
 */
// The code rests on the brand orange and cycles from there: the wallet's own colour first, the
// other account-card colours after it.
const QR_PALETTE_CYCLE: readonly QRPalette[] = ['orange', 'green', 'slate', 'blue', 'purple'];

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
  const { fieldRef, copy } = useCopyToClipboard();
  const [evmOpen, setEvmOpen] = useState(false);
  const { address: evmAddress, connected: evmConnected } = useEvmWalletConnection();
  const qrRef = useRef<QRCodeHandle>(null);

  // The logo easter egg. `TabLayout` keeps a visited tab mounted, so leaving the page is a change
  // of `usePageActive`, not an unmount: reset the cycle there or the QR keeps a stray colour.
  const pageActive = usePageActive();
  const [paletteStep, setPaletteStep] = useState(0);
  const [logoPressed, setLogoPressed] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (pageActive) return;
    setPaletteStep(0);
    setLogoPressed(false);
  }, [pageActive]);

  const cyclePalette = useCallback(() => {
    hapticLight();
    setPaletteStep(step => (step + 1) % QR_PALETTE_CYCLE.length);
  }, []);

  const releaseLogo = useCallback(() => setLogoPressed(false), []);

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
    copy();
  }, [copy, shareText, t]);

  const showCrossChain = !isExtension() && isBridgeDepositEnabled();

  return (
    // The shared home-group pane body (HomeGroupPane): the page margin, the 24px to the title, the
    // scroll and gesture contract and the clearance over the tab bar, the same as Send, Earn and
    // Swap. Last-resort scroll only: the column is laid out to fit between the top action bar and
    // the tab bar on every supported height, and scrolls only when even that does not fit.
    // The page keeps the app's own surface: the Receive green is carried by the affordances, not
    // by a wash, and the code needs a plain light field around it to scan off.
    <HomeGroupPaneBody testId="receive-page" title={t('receiveAt')} titleTestId="receive-title">
      {/* The clipboard fallback's field, never shown. */}
      <input ref={fieldRef} value={address} readOnly className="sr-only" tabIndex={-1} />
      {/* Hidden, untruncated address for E2E DOM fallback (visible address below is truncated). */}
      <span data-testid="receive-address-full" className="sr-only">
        {address}
      </span>

      {/* The code, its network and the address: one centred block on the page itself, no card
            around it — the card only added an edge between the code and the actions below. */}
      <div data-testid="receive-qr-block" className="flex flex-col items-center gap-2 pt-2">
        <div data-testid="receive-qr-card" className="flex w-full flex-col items-center gap-2">
          {/* The QR is a fixed square (208px), not the leftover height: big enough to scan
                across a table, small enough to leave the page room to breathe. */}
          <div data-testid="receive-qr-slot" className="relative w-full max-w-52">
            <motion.div
              data-testid="receive-qr-frame"
              className="aspect-square w-full"
              // The dip of the logo press. The card is what moves: the logo is drawn inside the
              // QR's own SVG, so it cannot be scaled on its own.
              animate={{ scale: logoPressed && !reduceMotion ? tabBarMotion.pressScale : 1 }}
              transition={resolveTransition(reduceMotion, tabBarMotion.press)}
            >
              <QRCode
                ref={qrRef}
                address={address}
                size={QR_EXPORT_SIZE}
                fluid
                palette={QR_PALETTE_CYCLE[paletteStep]}
                // The page names the network in the chip below; the shared image still carries it.
                caption={network ? t('qrNetworkCaption', { network }) : undefined}
                showCaption={false}
              />
            </motion.div>
            {/* The Bread logo in the middle of the code, as a target: each tap repaints the
                  modules in the next colour of the cycle. The logo itself is left alone. */}
            <button
              type="button"
              onClick={cyclePalette}
              onPointerDown={() => setLogoPressed(true)}
              onPointerUp={releaseLogo}
              onPointerCancel={releaseLogo}
              onPointerLeave={releaseLogo}
              onBlur={releaseLogo}
              aria-label={t('receiveQrColorAction')}
              data-testid="receive-qr-logo"
              data-qr-palette={QR_PALETTE_CYCLE[paletteStep]}
              className="absolute left-1/2 top-1/2 h-[28%] w-[28%] -translate-x-1/2 -translate-y-1/2 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-receive"
            />
          </div>
          {network && (
            <NetworkChip kind="miden" label={t('qrNetworkCaption', { network })} data-testid="receive-network" />
          )}
          <CopyButton
            text={address}
            data-testid="receive-copy-address"
            label={truncateAddress(address, false, 16, 8)}
            icon="leading"
            iconClassName="text-accent-receive"
            checkClassName="text-positive-ink"
            className="flex h-11 w-full items-center justify-center rounded-full bg-fill px-4 text-ink transition-colors hover:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-receive"
            contentClassName="gap-2 font-heading text-base leading-5 font-bold"
          />
        </div>
      </div>

      <div className="mt-2 flex shrink-0 flex-col gap-2">
        {/* The app's grouped `fill` list, with the flow accent on the glyphs, chevron and
              hairlines. */}
        <ListGroup data-testid="receive-actions">
          <ListRow
            icon={<Icon name={IconName.Share} size="xs" />}
            title={t('share')}
            accent="receive"
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
              accent="receive"
              chevron
              onClick={handleOpenEvm}
              data-testid="receive-cross-chain"
            />
          )}
        </ListGroup>
        {/* The funds-safety warning (#875), last: the page reads code → address → actions, and
              this qualifies all of it. A caption with the warning glyph, not a tinted block —
              between the address and the actions it split the page in two. */}
        {network && (
          <Notice
            tone="warning"
            variant="inline"
            icon={<Icon name={IconName.WarningFill} size="xs" fill="currentColor" />}
            data-testid="receive-test-funds-warning"
          >
            {t('receiveTestFundsBody', { network })}
          </Notice>
        )}
      </div>
      {showCrossChain && <EvmConnectModal open={evmOpen} onOpenChange={setEvmOpen} />}
    </HomeGroupPaneBody>
  );
};
