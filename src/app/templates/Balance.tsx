import React, { cloneElement, memo, ReactElement, useMemo } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';
import CSSTransition from 'react-transition-group/CSSTransition';

import { useHiddenTokens } from 'app/hooks/useHiddenTokens';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { valuedBalanceTotal } from 'lib/miden/front/fiat-total';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';

/** The valued total's move over 24 hours, in dollars and as a percentage of where it started. */
export interface BalanceChange {
  absolute: number;
  percentage: number;
}

type BalanceProps = {
  /** The fiat total, or null when the account holds tokens and none can be valued (unquoted or of unknown scale). */
  children: (b: BigNumber | null, change: BalanceChange | null) => ReactElement;
};

const Balance = memo<BalanceProps>(({ children }) => {
  const account = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);
  const bridgeConfig = useBridgeConfigSnapshot({ load: false });
  const { isHidden } = useHiddenTokens(account.publicKey);

  return useMemo(() => {
    // Pricing helpers read the runtime singleton; its snapshot invalidates cached values.
    void bridgeConfig;
    // The card sums what Home lists, and a hidden token is not listed (#813). What counts and what is left out is
    // `valuedBalanceTotal`'s rule, shared with the bridge-in ceiling.
    const { totalFiat, previousFiat, holdsAnything, valuedAnything } = valuedBalanceTotal(
      allTokenBalances,
      tokenPrices,
      isHidden
    );
    // No change to show without a valued total, or from a starting value of zero.
    const change =
      valuedAnything && previousFiat > 0
        ? { absolute: totalFiat - previousFiat, percentage: ((totalFiat - previousFiat) / previousFiat) * 100 }
        : null;
    const childNode = children(holdsAnything && !valuedAnything ? null : new BigNumber(totalFiat), change);
    const exist = true;

    return (
      <CSSTransition
        in={exist}
        timeout={200}
        classNames={{
          enter: 'opacity-0',
          enterActive: classNames('opacity-100', 'transition ease-out duration-200'),
          exit: classNames('opacity-0', 'transition ease-in duration-200')
        }}
      >
        {cloneElement(childNode, {
          className: classNames(childNode.props.className, !exist && 'invisible')
        })}
      </CSSTransition>
    );
  }, [children, allTokenBalances, isHidden, tokenPrices, bridgeConfig]);
});

export default Balance;
