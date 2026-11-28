import React from 'react';

import { Trans, useTranslation } from 'react-i18next';

import { HomeGroupPaneBody } from 'app/layouts/HomeGroupPane';
import { TokenLogo } from 'components/TokenLogo';
import { SlideToConfirm } from 'components/ui/SlideToConfirm';
import { cn } from 'lib/ui/util';

import {
  DepositAmount,
  depositAmountText,
  DepositFactCard,
  DepositFactRow,
  DepositFeeValue,
  DepositNotice,
  useUsdEstimateText
} from './parts';
import * as s from './styles';
import type {
  DepositAmountValue,
  DepositFee,
  DepositLayout,
  DepositNetworkDisplay,
  DepositTokenDisplay
} from './types';

/** The review warns when the bridge fee is more than this share of the deposit. */
export const HIGH_FEE_SHARE = 0.05;

export interface DepositReviewViewProps {
  /** `extension` takes the popup's tighter top space. Defaults to `mobile`. */
  layout?: DepositLayout;
  /** What arrives in the wallet, in `receivedToken` units. */
  received: DepositAmountValue;
  receivedUsd?: number;
  receivedToken: DepositTokenDisplay;
  /** What the user sends, in `sourceToken` units. */
  amount: DepositAmountValue;
  sourceToken: DepositTokenDisplay;
  network: DepositNetworkDisplay;
  bridgeFee: DepositFee;
  routeName: string;
  /** The route's arrival time, already translated. */
  arrivesIn: string;
  /** Who pays the network gas, already translated (the mock-up's `fees().gas`). Defaults to "Paid by Bread". */
  networkGas?: string;
  /** The bridge fee as a share of the deposit (0.08 = 8%). Above 0.05 the review warns. */
  feeShare?: number;
  /** A notice under the fee card, such as a failed slide. */
  notice?: React.ReactNode;
  /** The user slid the control to the end, or confirmed it from the keyboard. */
  onConfirm: () => void;
  /** Blocks the slide, for example while the quote refreshes. */
  confirmDisabled?: boolean;
  /** A new value puts the slide back at the start. */
  confirmResetKey?: string | number;
}

/**
 * The deposit review (mock-up `viewReview`): "You receive" as the headline, the line "You send X
 * from <network>", the high-fee warning, the fee card, and the slide that shows the deposit address.
 * The caller draws the page header ("Review deposit", with a close) above it.
 */
export const DepositReviewView: React.FC<DepositReviewViewProps> = ({
  layout = 'mobile',
  received,
  receivedUsd,
  receivedToken,
  amount,
  sourceToken,
  network,
  bridgeFee,
  routeName,
  arrivesIn,
  networkGas,
  feeShare,
  notice,
  onConfirm,
  confirmDisabled = false,
  confirmResetKey
}) => {
  const { t } = useTranslation();
  const usdText = useUsdEstimateText(receivedUsd);
  const highFee = feeShare !== undefined && feeShare > HIGH_FEE_SHARE;

  return (
    <HomeGroupPaneBody
      top="header"
      footer={
        <SlideToConfirm
          label={t('depositFlowSlideToShowAddress')}
          accent="send"
          onConfirm={onConfirm}
          disabled={confirmDisabled}
          resetKey={confirmResetKey}
          data-testid="deposit-review-slide"
        />
      }
    >
      <div className={cn(s.BASE, s.BODY_STACK, s.TOP_AFTER_HEADER.body[layout])}>
        <div className={s.HERO_A} data-testid="deposit-review-hero">
          <TokenLogo faucetId={receivedToken.logoFaucetId} size="2xl" />
          <span className={s.HERO_A_LABEL}>{t('depositFlowYouReceive')}</span>
          <DepositAmount
            value={received}
            symbol={receivedToken.symbol}
            rounding="down"
            className={s.HERO_A_AMOUNT}
            data-testid="deposit-review-received"
          />
          {usdText && <span className={s.HERO_A_USD}>{usdText}</span>}
        </div>
        <p className={s.SENDPILL} data-testid="deposit-review-send">
          <Trans
            i18nKey="depositFlowYouSendFrom"
            values={{
              amount: `${depositAmountText(amount, 'exact')} ${sourceToken.symbol}`,
              network: network.name
            }}
            components={{ b: <b className={s.SENDPILL_STRONG} /> }}
          />
        </p>
        {highFee && (
          <DepositNotice
            kind="big"
            title={t('depositFlowHighFeeTitle', { percent: String(Math.round(feeShare * 100)) })}
            data-testid="deposit-review-high-fee"
          >
            {t('depositFlowHighFeeBody')}
          </DepositNotice>
        )}
        <DepositFactCard data-testid="deposit-review-facts">
          <DepositFactRow label={t('depositFlowBridgeFee')} data-testid="deposit-review-fee">
            <DepositFeeValue fee={bridgeFee} symbol={sourceToken.symbol} />
          </DepositFactRow>
          <DepositFactRow label={t('depositFlowNetworkGas')}>
            {networkGas ?? t('depositFlowPaidByBread')}
          </DepositFactRow>
          <DepositFactRow label={t('route')}>{routeName}</DepositFactRow>
          <DepositFactRow label={t('time')}>{arrivesIn}</DepositFactRow>
        </DepositFactCard>
        {notice}
      </div>
    </HomeGroupPaneBody>
  );
};
