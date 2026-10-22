import React, { cloneElement, memo, ReactElement, useMemo } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';
import CSSTransition from 'react-transition-group/CSSTransition';

import { useHiddenTokens } from 'app/hooks/useHiddenTokens';
import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { valuedBalanceTotal } from 'lib/miden/front/fiat-total';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { useWalletStore } from 'lib/store';

type BalanceProps = {
  /** The fiat total, or null when the account holds tokens and none can be valued (unquoted or of unknown scale). */
  children: (b: BigNumber | null) => ReactElement;
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
    const { totalFiat, holdsAnything, valuedAnything } = valuedBalanceTotal(allTokenBalances, tokenPrices, isHidden);
    const childNode = children(holdsAnything && !valuedAnything ? null : new BigNumber(totalFiat));
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
