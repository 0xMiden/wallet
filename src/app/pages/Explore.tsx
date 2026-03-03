import React, { FC, FunctionComponent, SVGProps, useCallback, useEffect, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/receive-new.svg';
import { ReactComponent as SendIcon } from 'app/icons/send-new.svg';
import { ReactComponent as UpIcon } from 'app/icons/v2/up.svg';
import Header from 'app/layouts/PageLayout/Header';
import AddressChip from 'app/templates/AddressChip';
import { ChainInstabilityBanner } from 'components/ChainInstabilityBanner';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { TestIDProps } from 'lib/analytics';
import { MIDEN_NETWORK_NAME, MIDEN_FAUCET_ENDPOINTS } from 'lib/miden-chain/constants';
import { getFaucetUrl } from 'lib/miden-chain/faucet';
import {
  hasQueuedTransactions,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import {
  setFaucetIdSetting,
  useAccount,
  useAllBalances,
  useAllTokensBaseMetadata,
  useMidenContext,
  useNetwork
} from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { openFaucetWebview } from 'lib/mobile/faucet-webview';
import { hapticLight } from 'lib/mobile/haptics';
import { isExtension, isMobile } from 'lib/platform';
import { isAutoConsumeEnabled, isDelegateProofEnabled } from 'lib/settings/helpers';
import { useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';
import useTippy, { TippyProps } from 'lib/ui/useTippy';
import { Link, navigate, To } from 'lib/woozie';
import { isHexAddress } from 'utils/miden';

import { ExploreSelectors } from './Explore.selectors';
import MainBanner from './Explore/MainBanner';
import Tokens from './Explore/Tokens';

const Explore: FC = () => {
  const { t } = useTranslation();
  const tippyPropsMock = {
    trigger: 'mouseenter',
    hideOnClick: false,
    content: t('disabledForWatchOnlyAccount'),
    animation: 'shift-away-subtle'
  };
  const account = useAccount();
  const midenFaucetId = useMidenFaucetId();
  const { signTransaction } = useMidenContext();

  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  // Call useAllBalances before useClaimableNotes - balance fetch is fast (~5ms)
  // while claimable notes is slow (~500ms due to syncState). With the mutex
  // serializing operations, we want the fast one to run first.
  const { data: allTokenBalances = [] } = useAllBalances(account.publicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  const portfolioChange = useMemo(() => {
    const totalValue = allTokenBalances.reduce((sum, t) => {
      const p = tokenPrices[t.metadata.symbol]?.price ?? 1;
      return sum + t.balance * p;
    }, 0);
    if (totalValue === 0) return 0;
    return allTokenBalances.reduce((sum, t) => {
      const p = tokenPrices[t.metadata.symbol]?.price ?? 1;
      const c = tokenPrices[t.metadata.symbol]?.change24h ?? 0;
      const weight = (t.balance * p) / totalValue;
      return sum + c * weight;
    }, 0);
  }, [allTokenBalances, tokenPrices]);

  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(account.publicKey);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const shouldAutoConsume = isAutoConsumeEnabled();

  const address = account.publicKey;
  const network = useNetwork();

  const handleFaucetClick = useCallback(async () => {
    const faucetUrl = getFaucetUrl(network.id);
    await openFaucetWebview({ url: faucetUrl, title: t('midenFaucet'), recipientAddress: address });
  }, [network.id, t, address]);

  const midenNotes = useMemo(() => {
    if (!shouldAutoConsume || !claimableNotes) {
      return [];
    }

    return claimableNotes.filter(note => note!.faucetId === midenFaucetId);
  }, [claimableNotes, midenFaucetId, shouldAutoConsume]);

  const selfClaimableNotes = useMemo(() => {
    if (!shouldAutoConsume || !claimableNotes) {
      return [];
    }

    return claimableNotes.filter(note => note!.faucetId !== midenFaucetId);
  }, [claimableNotes, midenFaucetId, shouldAutoConsume]);

  const hasAutoConsumableNotes = useMemo(() => {
    return midenNotes.length > 0;
  }, [midenNotes]);

  const autoConsumeMidenNotes = useCallback(async () => {
    if (!shouldAutoConsume || !hasAutoConsumableNotes) {
      return;
    }

    // Filter to only notes not already being claimed
    const notesToClaim = midenNotes!.filter(note => !note.isBeingClaimed);
    if (notesToClaim.length === 0) {
      return;
    }

    const promises = notesToClaim.map(async note => {
      await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
    });
    await Promise.all(promises);
    mutateClaimableNotes();

    if (isExtension()) {
      // On extension: fire-and-forget — SW handles processing
      requestSWTransactionProcessing();
    } else {
      // Process auto-consume transactions silently in the background (no modal/tab)
      startBackgroundTransactionProcessing(signTransaction);
    }
  }, [
    midenNotes,
    isDelegatedProvingEnabled,
    mutateClaimableNotes,
    account.publicKey,
    shouldAutoConsume,
    hasAutoConsumableNotes,
    signTransaction
  ]);

  useEffect(() => {
    if (hasAutoConsumableNotes) {
      autoConsumeMidenNotes();
    }
  }, [autoConsumeMidenNotes, hasAutoConsumableNotes]);

  const { data: queuedDbTransactions } = useRetryableSWR(
    [`has-queued-transactions`, address],
    async () => hasQueuedTransactions(),
    {
      revalidateOnMount: true,
      refreshInterval: 15_000,
      dedupingInterval: 5_000
    }
  );

  // Check if user explicitly dismissed the transaction modal (prevents auto-reopen)
  const isTransactionModalDismissedByUser = useWalletStore(state => state.isTransactionModalDismissedByUser);

  useEffect(() => {
    // On mobile, don't auto-open the modal - it's intrusive and blocks UI
    // The modal is opened explicitly when user initiates send/claim
    if (isMobile()) return;
    // Don't auto-open if user explicitly dismissed the modal (they clicked Hide)
    if (isTransactionModalDismissedByUser) return;
    if (queuedDbTransactions) useWalletStore.getState().openTransactionModal();
  }, [queuedDbTransactions, isTransactionModalDismissedByUser]);

  useEffect(() => {
    // 6-17-25 Force wallet reset if account is still using hex address
    if (isHexAddress(address)) {
      navigate('/reset-required');
    }
  }, [address]);

  const fetchFaucetState = useCallback(async () => {
    fetch(`${MIDEN_FAUCET_ENDPOINTS.get(MIDEN_NETWORK_NAME.DEVNET)}/get_metadata`)
      .then(response => response.json())
      .then(data => {
        if (data.id !== midenFaucetId) {
          setFaucetIdSetting(data.id);
        }
      })
      .catch(error => {
        console.error('Error fetching faucet metadata:', error);
      });
  }, [midenFaucetId]);

  useEffect(() => {
    //fetchFaucetState();
  }, [fetchFaucetState]);

  if (isHexAddress(address)) {
    return null;
  }

  const sendLink = allTokenBalances.length > 0 ? '/send' : '/get-tokens';

  return (
    <div className="flex flex-col h-full text-heading-gray font-geist">
      <ConnectivityIssueBanner />
      <ChainInstabilityBanner />
      <Header />
      <div className={classNames('flex flex-col justify-start', 'pt-6')}>
        <div className="flex flex-col justify-center items-center">
          <MainBanner />
          <div className="flex items-center gap-1 mt-2">
            <UpIcon className={classNames('h-3.5 w-3.5', portfolioChange < 0 && 'rotate-180')} />
            <span
              className={classNames(
                'text-sm font-semibold',
                portfolioChange > 0 ? 'text-green-500' : portfolioChange < 0 ? 'text-red-500' : 'text-heading-gray'
              )}
            >
              {portfolioChange >= 0 ? '+' : ''}
              {portfolioChange.toFixed(2)}%
            </span>
          </div>
        </div>
        <div className={classNames('flex w-full pt-6 gap-3 items-center justify-evenly px-4')}>
          <ActionButton
            type="send"
            label={t('send')}
            Icon={SendIcon}
            to={sendLink}
            disabled={false}
            tippyProps={tippyPropsMock}
            testID={ExploreSelectors.SendButton}
          />
          <div className="relative flex-1">
            <ActionButton
              type="receive"
              label={t('receive')}
              Icon={ReceiveIcon}
              to="/receive"
              testID={ExploreSelectors.ReceiveButton}
            />
            {selfClaimableNotes.length > 0 && (
              <div className="absolute top-[25%] left-[95%] -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full border-2 border-white">
                {selfClaimableNotes.length}
              </div>
            )}
          </div>
          <ActionButton
            type="faucet"
            label={t('faucet')}
            Icon={FaucetIcon}
            to={isMobile() ? undefined : '/faucet'}
            onClick={isMobile() ? handleFaucetClick : undefined}
            testID={ExploreSelectors.FaucetButton}
          />
        </div>
      </div>
      <hr className="bg-grey-300 h-px m-4 opacity-20" />
      <div className="flex-1 min-h-0 overflow-y-auto relative">
        <div className={classNames('bg-transparent')}>
          <Tokens />
        </div>
      </div>
    </div>
  );
};

export default Explore;

interface ActionButtonProps extends TestIDProps {
  label: React.ReactNode;
  type: 'send' | 'receive' | 'faucet';
  Icon: FunctionComponent<SVGProps<SVGSVGElement>>;
  to?: To;
  onClick?: () => void;
  disabled?: boolean;
  tippyProps?: Partial<TippyProps>;
  className?: string;
  isActive?: boolean;
}

function getActionBgColor(type: 'send' | 'receive' | 'faucet') {
  switch (type) {
    case 'send':
      return 'bg-[#2E80C4]';
    case 'receive':
      return 'bg-[#38824A]';
    case 'faucet':
      return 'bg-[#777487]';
  }
}

const ActionButton: FC<ActionButtonProps> = ({
  label,
  Icon,
  type,
  to,
  onClick,
  disabled,
  tippyProps = {},
  testID,
  testIDProperties,
  className,
  isActive = false
}) => {
  const spanRef = useTippy<HTMLSpanElement>(tippyProps);
  const buttonContent = (
    <div className={classNames('flex flex-col items-center justify-center gap-1 w-full')}>
      <div className={classNames('py-5 w-full flex items-center justify-center rounded-10', getActionBgColor(type))}>
        <Icon style={{ height: '24px', width: '24px' }} fill="white" />
      </div>
      <span className={classNames('text-sm font-medium', disabled && !isActive && 'text-gray-400')}>{label}</span>
    </div>
  );

  if (disabled) {
    return (
      <span className={classNames('flex flex-col items-center flex-1', className)} ref={spanRef}>
        {buttonContent}
      </span>
    );
  }

  if (onClick) {
    const handleClick = () => {
      hapticLight();
      onClick();
    };
    return (
      <button
        type="button"
        className={classNames('flex flex-col items-center w-full flex-1', className)}
        onClick={handleClick}
        data-testid={testID}
      >
        {buttonContent}
      </button>
    );
  }

  return (
    <Link
      testID={testID}
      testIDProperties={testIDProperties}
      to={to!}
      className={classNames('flex flex-col items-center w-full flex-1', className)}
    >
      {buttonContent}
    </Link>
  );
};
