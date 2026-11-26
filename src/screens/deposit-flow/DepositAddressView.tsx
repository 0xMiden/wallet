import React from 'react';

import { useTranslation } from 'react-i18next';

import { Icon, IconName } from 'app/icons/v2';
import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { Button, ButtonVariant } from 'components/Button';
import { QRCode } from 'components/QRCode';
import { TokenLogo } from 'components/TokenLogo';
import { AnimatedCopyIcon } from 'components/ui/AnimatedCopyIcon';
import { CopyButton } from 'components/ui/CopyButton';
import { CopyLabel } from 'components/ui/CopyLabel';
import { hapticLight } from 'lib/mobile/haptics';
import { useUserVisibleError } from 'lib/telemetry/use-user-visible-error';
import type { UserErrorId } from 'lib/telemetry/user-visible-error-contract';
import { useClipboardCopy } from 'lib/ui/useClipboardCopy';
import { cn } from 'lib/ui/util';

import {
  DepositAmount,
  depositAmountText,
  depositExactText,
  DepositFactCard,
  DepositFactRow,
  DepositFeeValue,
  DepositNotice
} from './parts';
import * as s from './styles';
import type {
  DepositAmountValue,
  DepositFee,
  DepositLayout,
  DepositNetworkDisplay,
  DepositTokenDisplay
} from './types';

/** Resolution of the QR image; on screen the code fills its card. */
const QR_SIZE = 300;
/** The mock-up's `lines7`: an address breaks into lines of about this many characters. */
const ADDRESS_LINE_CHARS = 22;

/**
 * Where the deposit stands:
 * - `waiting`: nothing has arrived yet.
 * - `partial`: less than the reviewed amount arrived. The screen offers to deposit what arrived.
 * - `failed`: the deposit cannot be used, or the bridge did not start. `title` and `reason` replace the default texts.
 *   `errorId` reports the failure (default `raw_bridge_deposit_failed`).
 * - `starting`: the funds are at the address and the bridge is starting. The actions are disabled.
 */
export type DepositAddressStatus =
  | { kind: 'waiting' }
  | { kind: 'partial'; received: DepositAmountValue }
  | { kind: 'failed'; title?: string; reason?: string; errorId?: UserErrorId }
  | { kind: 'starting' };

export interface DepositAddressViewProps {
  /** `mobile` is the mock-up's `viewAddressH`; `extension` its `viewAddressQR`. */
  layout: DepositLayout;
  /** The deposit address, in full. */
  address: string;
  /** What the QR code carries. Defaults to the address. */
  qrValue?: string;
  /** The reviewed amount the user must send, in `sourceToken` units. */
  amount: DepositAmountValue;
  sourceToken: DepositTokenDisplay;
  network: DepositNetworkDisplay;
  /** What arrives in the wallet, in `receivedToken` units. */
  received: DepositAmountValue;
  receivedToken: DepositTokenDisplay;
  bridgeFee: DepositFee;
  routeName: string;
  /** The route's arrival time, already translated. */
  arrivesIn: string;
  status: DepositAddressStatus;
  /** Mobile: opens the QR sheet. */
  onShowQr: () => void;
  /** Mobile: opens the wallet sheet. Omit when no wallet link exists: the action is not shown. */
  onOpenWallet?: () => void;
  /** `partial`: goes back to review with the amount that arrived. */
  onDepositReceived: () => void;
}

/** The mock-up's `lines7`: the address in lines of at most about 22 characters, all lines the same length. */
export function addressLines(address: string): string[] {
  if (!address) return [];
  const count = Math.ceil(address.length / ADDRESS_LINE_CHARS);
  const per = Math.ceil(address.length / count);
  const lines: string[] = [];
  for (let index = 0; index < address.length; index += per) lines.push(address.slice(index, index + per));
  return lines;
}

/** The mock-up's amount size: 72px up to 5 characters, 56px up to 8, else 40px. */
export function amountFontClass(text: string): string {
  if (text.length <= 5) return 'text-[72px]';
  if (text.length <= 8) return 'text-[56px]';
  return 'text-[40px]';
}

/** The short address of the extension's copy pill: `0x` and 6 characters, an ellipsis, the last 6. */
function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

/**
 * The deposit address screen. Mobile (`viewAddressH`): the amount and the address as tap-to-copy
 * blocks, three actions, the details card and the waiting strip. Extension (`viewAddressQR`): the
 * QR card, the network chip, the copy pill, the details card and the waiting note. The caller draws
 * the page header above it and the QR and wallet sheets beside it.
 */
export const DepositAddressView: React.FC<DepositAddressViewProps> = props =>
  props.layout === 'extension' ? <ExtensionAddress {...props} /> : <MobileAddress {...props} />;

const MobileAddress: React.FC<DepositAddressViewProps> = ({
  address,
  amount,
  sourceToken,
  network,
  received,
  receivedToken,
  bridgeFee,
  routeName,
  arrivesIn,
  status,
  onShowQr,
  onOpenWallet,
  onDepositReceived
}) => {
  const { t } = useTranslation();
  const amountText = depositExactText(amount);
  const amountCopy = useClipboardCopy(amountText);
  const addressCopy = useClipboardCopy(address);
  const locked = status.kind === 'starting';

  const copyAmount = () => {
    hapticLight();
    amountCopy.copy();
  };
  const copyAddress = () => {
    hapticLight();
    addressCopy.copy();
  };

  return (
    <HomeGroupPaneBody top="header" footer={status.kind === 'failed' ? undefined : <WaitingStrip status={status} />}>
      <div className={cn(s.BASE, s.H8, s.TOP_AFTER_HEADER.addressMobile)} data-testid="deposit-address-mobile">
        <span className={s.LAB8} aria-live="polite" data-testid="deposit-address-amount-label">
          {amountCopy.copied ? t('depositFlowAmountCopied') : t('depositFlowDepositAmount')}
        </span>
        <button
          type="button"
          onClick={copyAmount}
          disabled={locked}
          aria-label={t('depositFlowCopyAmount')}
          className={cn(s.AMT8, amountFontClass(amountText))}
          data-testid="deposit-address-amount"
        >
          {amountText}
        </button>
        <span className={s.TOK8}>
          <TokenLogo faucetId={sourceToken.logoFaucetId} size="sm" />
          {t('depositFlowTokenOnNetwork', { token: sourceToken.symbol, network: network.name })}
        </span>
        <span className={s.RCV8} data-testid="deposit-address-receive">
          {t('depositFlowYouReceive')}
          <b className={s.RCV8_STRONG}>
            <TokenLogo faucetId={receivedToken.logoFaucetId} size="sm" />
            <DepositAmount value={received} symbol={receivedToken.symbol} rounding="down" />
          </b>
        </span>
        <div aria-hidden="true" className={s.RULE8} />
        <span className={cn(s.LAB8, s.LAB8_S)}>{t('depositFlowToThisAddress')}</span>
        <button
          type="button"
          onClick={copyAddress}
          disabled={locked}
          aria-label={t('depositFlowCopyAddress')}
          className={s.ADC8}
          data-testid="deposit-address-block"
        >
          <span className={s.AD7} data-testid="deposit-address-lines">
            {addressLines(address).map(line => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </button>
        <div className={s.ACT8}>
          <button
            type="button"
            onClick={copyAddress}
            disabled={locked}
            className={s.A8}
            data-testid="deposit-address-copy"
          >
            <i className={cn(s.A8_CIRCLE, s.A8_CIRCLE_LEAD)}>
              <AnimatedCopyIcon copied={addressCopy.copied} size="sm" />
            </i>
            <span aria-live="polite">
              <CopyLabel copied={addressCopy.copied} copiedLabel={t('copied')}>
                {t('copy')}
              </CopyLabel>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              hapticLight();
              onShowQr();
            }}
            disabled={locked}
            aria-haspopup="dialog"
            className={s.A8}
            data-testid="deposit-address-qr"
          >
            <i className={s.A8_CIRCLE}>
              <Icon name={IconName.QrScan} fill="currentColor" aria-hidden="true" className={s.ICON_20} />
            </i>
            {t('depositFlowQrCode')}
          </button>
          {onOpenWallet && (
            <button
              type="button"
              onClick={() => {
                hapticLight();
                onOpenWallet();
              }}
              disabled={locked}
              aria-haspopup="dialog"
              className={s.A8}
              data-testid="deposit-address-open-wallet"
            >
              <i className={s.A8_CIRCLE}>
                <Icon name={IconName.Wallet} aria-hidden="true" className={s.ICON_20} />
              </i>
              {t('openWallet')}
            </button>
          )}
        </div>
        <DepositFactCard className={s.H8_DCARD} data-testid="deposit-address-facts">
          <DepositFactRow label={t('depositFlowBridgeFee')}>
            <DepositFeeValue fee={bridgeFee} symbol={sourceToken.symbol} />
          </DepositFactRow>
          <DepositFactRow label={t('route')}>{routeName}</DepositFactRow>
          <DepositFactRow label={t('depositFlowArrivesIn')}>{arrivesIn}</DepositFactRow>
        </DepositFactCard>
        <StatusNotice
          status={status}
          amount={amount}
          sourceToken={sourceToken}
          onDepositReceived={onDepositReceived}
          className={s.H8_NOTICE}
        />
      </div>
    </HomeGroupPaneBody>
  );
};

const ExtensionAddress: React.FC<DepositAddressViewProps> = ({
  address,
  qrValue,
  amount,
  sourceToken,
  network,
  received,
  receivedToken,
  arrivesIn,
  status,
  onDepositReceived
}) => {
  const { t } = useTranslation();
  const note = (() => {
    switch (status.kind) {
      case 'waiting':
      case 'partial':
        return t('depositFlowWaitingNote');
      case 'starting':
        return t('depositFlowStartingNote');
      case 'failed':
        return '';
    }
  })();
  return (
    <HomeGroupPaneBody top="header">
      <div
        className={cn(s.BASE, s.BODY_STACK, s.TOP_AFTER_HEADER.body.extension)}
        data-testid="deposit-address-extension"
      >
        <div className={s.QRCARD_EXT} data-testid="deposit-address-qr-card">
          <QRCode address={qrValue ?? address} payload="plain" size={QR_SIZE} palette="blue" />
        </div>
        <span className={s.CHIP_ON} data-testid="deposit-address-network">
          {network.name}
        </span>
        <CopyButton
          text={address}
          label={shortAddress(address)}
          icon="leading"
          iconClassName={s.ICON_18}
          checkClassName="text-positive-ink"
          disabled={status.kind === 'starting'}
          aria-label={t('depositFlowCopyAddress')}
          className={cn(s.COPY_PILL, 'text-[16px] leading-[22px]')}
          contentClassName="gap-2"
          data-testid="deposit-address-copy-pill"
        />
        <StatusNotice status={status} amount={amount} sourceToken={sourceToken} onDepositReceived={onDepositReceived} />
        <DepositFactCard layout="extension" data-testid="deposit-address-facts">
          <DepositFactRow label={t('address')}>{t('depositFlowYourEvmAddress')}</DepositFactRow>
          <DepositFactRow label={t('depositFlowYouReceive')}>
            <DepositAmount value={received} symbol={receivedToken.symbol} rounding="down" />
          </DepositFactRow>
          <DepositFactRow label={t('depositFlowYouSend')}>
            <DepositAmount value={amount} symbol={sourceToken.symbol} rounding="exact" />
          </DepositFactRow>
          <DepositFactRow label={t('depositFlowArrivesIn')}>{arrivesIn}</DepositFactRow>
        </DepositFactCard>
        <p className={cn(s.NOTE, 'text-center')} aria-live="polite" data-testid="deposit-address-note">
          {note}
        </p>
      </div>
    </HomeGroupPaneBody>
  );
};

/** The mobile footer strip (`.wait4`): a turning ring and two lines. */
const WaitingStrip: React.FC<{ status: DepositAddressStatus }> = ({ status }) => {
  const { t } = useTranslation();
  const starting = status.kind === 'starting';
  return (
    // The strip runs edge to edge over the footer's own gutter and top space, as the mock-up's does.
    <div role="status" className={cn(s.BASE, s.WAIT4, '-mx-4 -mt-3')} data-testid="deposit-address-waiting">
      <span aria-hidden="true" className={s.DOT4} />
      <span>
        <b className={s.WAIT4_TITLE}>{starting ? t('depositFlowStartingTitle') : t('depositFlowWaitingTitle')}</b>
        <small className={s.WAIT4_SMALL}>{starting ? t('depositFlowStartingBody') : t('depositFlowWaitingBody')}</small>
      </span>
    </div>
  );
};

/** The notice of a partial or failed deposit; nothing for the other states. */
const StatusNotice: React.FC<{
  status: DepositAddressStatus;
  amount: DepositAmountValue;
  sourceToken: DepositTokenDisplay;
  onDepositReceived: () => void;
  className?: string;
}> = ({ status, amount, sourceToken, onDepositReceived, className }) => {
  const { t } = useTranslation();
  useUserVisibleError(status.kind === 'failed' ? (status.errorId ?? 'raw_bridge_deposit_failed') : null, 'notice');
  switch (status.kind) {
    case 'failed':
      return (
        <DepositNotice
          kind="negative"
          role="alert"
          title={status.title ?? t('depositFlowFailedTitle')}
          className={className}
          data-testid="deposit-address-failed"
        >
          {status.reason ?? t('depositFlowFailedBody')}
        </DepositNotice>
      );
    case 'partial': {
      const arrived = `${depositAmountText(status.received, 'exact')} ${sourceToken.symbol}`;
      return (
        <DepositNotice
          kind="big"
          role="status"
          title={t('depositFlowPartialTitle', {
            received: arrived,
            expected: `${depositAmountText(amount, 'exact')} ${sourceToken.symbol}`
          })}
          className={className}
          data-testid="deposit-address-partial"
          action={
            <Button
              variant={ButtonVariant.Secondary}
              title={t('depositFlowPartialAction', { amount: arrived })}
              onClick={onDepositReceived}
              className="mt-3 w-full max-w-none"
              data-testid="deposit-address-partial-action"
            />
          }
        >
          {t('depositFlowPartialBody')}
        </DepositNotice>
      );
    }
    case 'waiting':
    case 'starting':
      return null;
  }
};
