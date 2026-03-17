import React, { FC, FunctionComponent, SVGProps, useCallback, useEffect, useMemo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { useAppEnv } from 'app/env';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { ReactComponent as FaucetIcon } from 'app/icons/faucet.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/receive.svg';
import { ReactComponent as SendIcon } from 'app/icons/send.svg';
import Header from 'app/layouts/PageLayout/Header';
import AddressChip from 'app/templates/AddressChip';
import { ChainInstabilityBanner } from 'components/ChainInstabilityBanner';
import { ConnectivityIssueBanner } from 'components/ConnectivityIssueBanner';
import { TestIDProps } from 'lib/analytics';
import { MIDEN_NETWORK_NAME, MIDEN_FAUCET_ENDPOINTS } from 'lib/miden-chain/constants';
import { getFaucetUrl } from 'lib/miden-chain/faucet';
import {
  getFailedConsumeTransactions,
  hasQueuedTransactions,
  initiateConsumeTransaction,
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
import { isMobile } from 'lib/platform';
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

  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(account.publicKey);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const shouldAutoConsume = isAutoConsumeEnabled();

  const address = account.publicKey;
  const { fullPage } = useAppEnv();
  const network = useNetwork();

  const handleFaucetClick = useCallback(async () => {
    const faucetUrl = getFaucetUrl(network.id);
    await openFaucetWebview({ url: faucetUrl, title: t('midenFaucet'), recipientAddress: address });
  }, [network.id, t, address]);

  const { data: failedConsumeTransactions } = useRetryableSWR(
    [`failed-transactions`, address],
    async () => getFailedConsumeTransactions(address),
    {
      revalidateOnMount: true,
      refreshInterval: 15_000,
      dedupingInterval: 10_000
    }
  );
  const failedConsumeNoteIds = useMemo(() => {
    return new Set(failedConsumeTransactions?.map(tx => tx.noteId) ?? []);
  }, [failedConsumeTransactions]);
  const hasLoadedFailedConsumeTransactions = failedConsumeTransactions !== undefined;
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
    if (!shouldAutoConsume || !hasAutoConsumableNotes || !hasLoadedFailedConsumeTransactions) {
      return;
    }

    // Filter to only notes not already being claimed
    const notesToClaim = midenNotes!.filter(note => !note.isBeingClaimed);
    if (notesToClaim.length === 0) {
      return;
    }
    const promises = notesToClaim.map(async note => {
      if (failedConsumeNoteIds.has(note.id)) {
        console.warn('Skipping auto-consume for note with previous failed transaction', note.id);
        return;
      }
      await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
    });
    await Promise.all(promises);
    mutateClaimableNotes();

    // Process auto-consume transactions silently in the background (no modal/tab)
    startBackgroundTransactionProcessing(signTransaction);
  }, [
    midenNotes,
    failedConsumeNoteIds,
    hasLoadedFailedConsumeTransactions,
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

  const background = 'url(/misc/bg.svg) white center top / cover no-repeat';
  const sendLink = allTokenBalances.length > 0 ? '/send' : '/get-tokens';

  // Content only - container and footer provided by TabLayout
  return (
    <>
      <ConnectivityIssueBanner />
      <ChainInstabilityBanner />
      <div className={classNames('flex-none', fullPage && 'rounded-t-3xl')} style={{ background }}>
        <Header />
        <div className={classNames('flex flex-col justify-start mt-6')}>
          <div className="flex flex-col w-full justify-center items-center">
            <MainBanner />
            <AddressChip address={account.publicKey} className="flex items-center" />
          </div>
          <div className="flex justify-evenly items-center w-full mt-1 px-2 mb-4">
            <ActionButton
              label={t('send')}
              Icon={SendIcon}
              to={sendLink}
              disabled={false}
              tippyProps={tippyPropsMock}
              testID={ExploreSelectors.SendButton}
            />
            <div className="relative">
              <ActionButton
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
              label={t('faucet')}
              Icon={FaucetIcon}
              to={isMobile() ? undefined : '/faucet'}
              onClick={isMobile() ? handleFaucetClick : undefined}
              testID={ExploreSelectors.FaucetButton}
              iconStyle={{ height: '20px', width: '20px', stroke: 'none' }}
            />
          </div>
        </div>
      </div>

      <div className="flex-grow overflow-y-auto relative" style={{ scrollbarGutter: 'stable' }}>
        <div className={classNames('bg-transparent', 'md:w-[460px] md:mx-auto px-4')}>
          <Tokens />
        </div>
      </div>
    </>
  );
};

export default Explore;

interface ActionButtonProps extends TestIDProps {
  label: React.ReactNode;
  Icon: FunctionComponent<SVGProps<SVGSVGElement>>;
  to?: To;
  onClick?: () => void;
  disabled?: boolean;
  tippyProps?: Partial<TippyProps>;
  className?: string;
  iconStyle?: React.CSSProperties;
}

const ActionButton: FC<ActionButtonProps> = ({
  label,
  Icon,
  to,
  onClick,
  disabled,
  tippyProps = {},
  testID,
  testIDProperties,
  className,
  iconStyle
}) => {
  const spanRef = useTippy<HTMLSpanElement>(tippyProps);
  const buttonContent = (
    <>
      <div className={classNames('mb-1 flex flex-col items-center', 'rounded-lg', 'pt-1')}>
        <div
          className={classNames(
            'py-1 flex flex-col justify-center bg-primary-500',
            !isMobile() && 'hover:bg-primary-600'
          )}
          style={{
            height: '48px',
            width: '48px',
            borderRadius: '24px'
          }}
        >
          <Icon
            style={{
              margin: 'auto',
              height: '12px',
              width: '12px',
              stroke: `${disabled ? '#CBD5E0' : '#FFF'}`,
              ...iconStyle
            }}
          />
        </div>
        <span
          className={classNames('text-xs text-center', disabled ? 'text-gray-400' : 'text-black', 'py-1')}
          style={{
            fontSize: '12px',
            lineHeight: '16px'
          }}
        >
          {label}
        </span>
      </div>
    </>
  );

  if (disabled) {
    return (
      <span className={classNames('flex flex-col items-center', className)} ref={spanRef}>
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
        className={classNames('flex flex-col items-center', className)}
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
      className={classNames('flex flex-col items-center', className)}
    >
      {buttonContent}
    </Link>
  );
};
