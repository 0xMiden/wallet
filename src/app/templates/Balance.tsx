import React, { cloneElement, memo, ReactElement, useMemo } from 'react';

import BigNumber from 'bignumber.js';
import classNames from 'clsx';
import CSSTransition from 'react-transition-group/CSSTransition';

import { useAccount, useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { getTokenPrice } from 'lib/prices';
import { useWalletStore } from 'lib/store';

type BalanceProps = {
  children: (b: BigNumber) => ReactElement;
};

const Balance = memo<BalanceProps>(({ children }) => {
  const account = useAccount();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  return useMemo(() => {
    const totalFiat = allTokenBalances.reduce((sum, token) => {
      const { price } = getTokenPrice(tokenPrices, token.metadata.symbol);
      return sum + token.balance * price;
    }, 0);
    const childNode = children(new BigNumber(totalFiat));
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
  }, [children, allTokenBalances, tokenPrices]);
});

export default Balance;
