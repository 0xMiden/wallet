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

import { formatCountdown, useCountdown } from './expiry-countdown';
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
 * The memo value of the details card, a tap-to-copy button in the `.dcard b` type. The mock-up has no memo: the row
 * takes the card's row style, and the copy glyph follows the value.
 */
const MEMO_VALUE =
  'inline-flex min-w-0 items-center justify-end gap-1.5 text-right disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary';

/**
 * Where the deposit stands:
 * - `waiting`: nothing has arrived yet.
 * - `partial`: less than the reviewed amount arrived. `received` is that amount, when it is known. With
 *   `onDepositReceived`, the screen offers to deposit what arrived; without it, the screen asks for the rest.
 * - `failed`: the deposit cannot be used, or the bridge did not start. `title` and `reason` replace the default texts.
 *   `errorId` reports the failure (default `raw_bridge_deposit_failed`; null reports nothing). `hideAddress`: the
 *   address takes no deposit any more (it expired), so the screen does not show it, its QR code or its actions.
 * - `starting`: the funds are at the address and the bridge is starting. The actions are disabled.
 */
export type DepositAddressStatus =
  | { kind: 'waiting' }
  | { kind: 'partial'; received?: DepositAmountValue }
  | { kind: 'failed'; title?: string; reason?: string; errorId?: UserErrorId | null; hideAddress?: boolean }
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
  /**
   * The time (Unix milliseconds) after which the address takes no deposit. With it, the extension details card shows
   * "Address expires in" with a countdown, and the mobile strip says when the address expires. Omit it for an address
   * that does not expire (the relay address): the screen then shows no countdown.
   */
  expiresAt?: number;
  /**
   * The address is the wallet's own EVM address (the relay address): the extension details card names it in an
   * Address row. Set false for an address of a provider (a NEAR Intents deposit address). Default true.
   */
  ownAddress?: boolean;
  /** A memo that the deposit must carry. The details card shows it with a copy action, and a warning follows. */
  memo?: string;
  /** Mobile: opens the QR sheet. */
  onShowQr: () => void;
  /** Mobile: opens the wallet sheet. Omit when no wallet link exists: the action is not shown. */
  onOpenWallet?: () => void;
  /** `partial`: goes back to review with the amount that arrived. Omit it when the route cannot do that. */
  onDepositReceived?: () => void;
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

/** True when the status says that the address takes no deposit any more. */
function addressHidden(status: DepositAddressStatus): boolean {
  return status.kind === 'failed' && status.hideAddress === true;
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
  expiresAt,
  memo,
  onShowQr,
  onOpenWallet,
  onDepositReceived
}) => {
  const { t } = useTranslation();
  const amountText = depositExactText(amount);
  const amountCopy = useClipboardCopy(amountText);
  const addressCopy = useClipboardCopy(address);
  const hidden = addressHidden(status);
  const locked = status.kind === 'starting' || hidden;

  const copyAmount = () => {
    hapticLight();
    amountCopy.copy();
  };
  const copyAddress = () => {
    hapticLight();
    addressCopy.copy();
  };

  return (
    <HomeGroupPaneBody
      top="header"
      footer={status.kind === 'failed' ? undefined : <WaitingStrip status={status} expiresAt={expiresAt} />}
    >
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
        {!hidden && (
          <>
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
          </>
        )}
        <DepositFactCard className={s.H8_DCARD} data-testid="deposit-address-facts">
          <DepositFactRow label={t('depositFlowBridgeFee')}>
            <DepositFeeValue fee={bridgeFee} symbol={sourceToken.symbol} />
          </DepositFactRow>
          <DepositFactRow label={t('route')}>{routeName}</DepositFactRow>
          <DepositFactRow label={t('depositFlowArrivesIn')}>{arrivesIn}</DepositFactRow>
          {memo && !hidden && <MemoRow memo={memo} disabled={locked} />}
        </DepositFactCard>
        {memo && !hidden && <MemoWarning className={s.H8_NOTICE} />}
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
  expiresAt,
  ownAddress = true,
  memo,
  onDepositReceived
}) => {
  const { t } = useTranslation();
  const hidden = addressHidden(status);
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
        {!hidden && (
          <div className={s.QRCARD_EXT} data-testid="deposit-address-qr-card">
            <QRCode address={qrValue ?? address} payload="plain" size={QR_SIZE} palette="blue" />
          </div>
        )}
        <span className={s.CHIP_ON} data-testid="deposit-address-network">
          {network.name}
        </span>
        {!hidden && (
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
        )}
        <StatusNotice status={status} amount={amount} sourceToken={sourceToken} onDepositReceived={onDepositReceived} />
        <DepositFactCard layout="extension" data-testid="deposit-address-facts">
          {ownAddress && <DepositFactRow label={t('address')}>{t('depositFlowYourEvmAddress')}</DepositFactRow>}
          <DepositFactRow label={t('depositFlowYouReceive')}>
            <DepositAmount value={received} symbol={receivedToken.symbol} rounding="down" />
          </DepositFactRow>
          <DepositFactRow label={t('depositFlowYouSend')}>
            <DepositAmount value={amount} symbol={sourceToken.symbol} rounding="exact" />
          </DepositFactRow>
          <DepositFactRow label={t('depositFlowArrivesIn')}>{arrivesIn}</DepositFactRow>
          {expiresAt !== undefined && (
            <DepositFactRow label={t('depositFlowAddressExpiresIn')} data-testid="deposit-address-expiry">
              <Countdown expiresAt={expiresAt} />
            </DepositFactRow>
          )}
          {memo && !hidden && <MemoRow memo={memo} disabled={status.kind === 'starting'} />}
        </DepositFactCard>
        {memo && !hidden && <MemoWarning />}
        <p className={cn(s.NOTE, 'text-center')} aria-live="polite" data-testid="deposit-address-note">
          {note}
        </p>
      </div>
    </HomeGroupPaneBody>
  );
};

/** The time left until `expiresAt` (mock-up `clock()`). Only this text renders again each second. */
const Countdown: React.FC<{ expiresAt: number }> = ({ expiresAt }) => {
  const left = useCountdown(expiresAt);
  return <>{formatCountdown(left)}</>;
};

/**
 * The second line of the waiting strip of an address that expires: "Address expires in <m:ss>. You can leave Bread.
 * We'll notify you." Only this line renders again each second.
 */
const ExpiringWaitingBody: React.FC<{ expiresAt: number }> = ({ expiresAt }) => {
  const { t } = useTranslation();
  const left = useCountdown(expiresAt);
  return <>{t('depositFlowExpiringBody', { countdown: formatCountdown(left) })}</>;
};

/** The mobile footer strip (`.wait4`): a turning ring and two lines. */
const WaitingStrip: React.FC<{ status: DepositAddressStatus; expiresAt?: number }> = ({ status, expiresAt }) => {
  const { t } = useTranslation();
  const starting = status.kind === 'starting';
  const body = (() => {
    if (starting) return t('depositFlowStartingBody');
    if (expiresAt === undefined) return t('depositFlowWaitingBody');
    return <ExpiringWaitingBody expiresAt={expiresAt} />;
  })();
  return (
    // The strip runs edge to edge over the footer's own gutter and top space, as the mock-up's does.
    <div role="status" className={cn(s.BASE, s.WAIT4, '-mx-4 -mt-3')} data-testid="deposit-address-waiting">
      <span aria-hidden="true" className={s.DOT4} />
      <span>
        <b className={s.WAIT4_TITLE}>{starting ? t('depositFlowStartingTitle') : t('depositFlowWaitingTitle')}</b>
        <small className={s.WAIT4_SMALL} data-testid="deposit-address-waiting-body">
          {body}
        </small>
      </span>
    </div>
  );
};

/** The Memo row of the details card: the memo as a tap-to-copy value. */
const MemoRow: React.FC<{ memo: string; disabled: boolean }> = ({ memo, disabled }) => {
  const { t } = useTranslation();
  const memoCopy = useClipboardCopy(memo);
  return (
    <DepositFactRow label={t('nearIntentsDepositMemo')} data-testid="deposit-address-memo">
      <button
        type="button"
        onClick={() => {
          hapticLight();
          memoCopy.copy();
        }}
        disabled={disabled}
        aria-label={t('nearIntentsCopyMemo')}
        className={MEMO_VALUE}
        data-testid="deposit-address-memo-copy"
      >
        <span className="select-text [overflow-wrap:anywhere]">{memo}</span>
        <AnimatedCopyIcon copied={memoCopy.copied} size="sm" />
      </button>
    </DepositFactRow>
  );
};

/** The warning under a details card with a memo: a deposit without the memo can be lost. */
const MemoWarning: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation();
  return (
    <DepositNotice kind="inline" className={className} data-testid="deposit-address-memo-warning">
      {t('nearIntentsMemoWarning')}
    </DepositNotice>
  );
};

/** The notice of a partial or failed deposit; nothing for the other states. */
const StatusNotice: React.FC<{
  status: DepositAddressStatus;
  amount: DepositAmountValue;
  sourceToken: DepositTokenDisplay;
  onDepositReceived?: () => void;
  className?: string;
}> = ({ status, amount, sourceToken, onDepositReceived, className }) => {
  const { t } = useTranslation();
  const errorId = status.kind === 'failed' ? status.errorId : null;
  useUserVisibleError(errorId === undefined ? 'raw_bridge_deposit_failed' : errorId, 'notice');
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
      const expected = `${depositAmountText(amount, 'exact')} ${sourceToken.symbol}`;
      const arrived =
        status.received === undefined
          ? undefined
          : `${depositAmountText(status.received, 'exact')} ${sourceToken.symbol}`;
      // The action deposits what arrived: only a route that can do that offers it.
      const offersArrived = arrived !== undefined && onDepositReceived !== undefined;
      return (
        <DepositNotice
          kind="big"
          role="status"
          title={
            arrived === undefined
              ? t('depositFlowPartialUnknownTitle', { expected })
              : t('depositFlowPartialTitle', { received: arrived, expected })
          }
          className={className}
          data-testid="deposit-address-partial"
          action={
            offersArrived ? (
              <Button
                variant={ButtonVariant.Secondary}
                title={t('depositFlowPartialAction', { amount: arrived })}
                onClick={onDepositReceived}
                className="mt-3 w-full max-w-none"
                data-testid="deposit-address-partial-action"
              />
            ) : undefined
          }
        >
          {offersArrived ? t('depositFlowPartialBody') : t('depositFlowPartialRestBody')}
        </DepositNotice>
      );
    }
    case 'waiting':
    case 'starting':
      return null;
  }
};
