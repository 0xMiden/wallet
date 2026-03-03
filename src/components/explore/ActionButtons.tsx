import React, { FC, FunctionComponent, SVGProps, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as FaucetIcon } from 'app/icons/faucet-new.svg';
import { ReactComponent as ReceiveIcon } from 'app/icons/receive-new.svg';
import { ReactComponent as SendIcon } from 'app/icons/send-new.svg';
import { ExploreSelectors } from 'app/pages/Explore.selectors';
import { TestIDProps } from 'lib/analytics';
import { getFaucetUrl } from 'lib/miden-chain/faucet';
import { useNetwork } from 'lib/miden/front';
import { openFaucetWebview } from 'lib/mobile/faucet-webview';
import { hapticLight } from 'lib/mobile/haptics';
import { isMobile } from 'lib/platform';
import useTippy, { TippyProps } from 'lib/ui/useTippy';
import { Link, To } from 'lib/woozie';

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

const ACTION_BUTTONS: (t: any, handleFaucetClick: () => void) => ActionButtonProps[] = (t: any, handleFaucetClick) => [
  {
    type: 'send',
    label: t('send'),
    Icon: SendIcon,
    to: '/send',
    testID: ExploreSelectors.SendButton
  },
  {
    type: 'receive',
    label: t('receive'),
    Icon: ReceiveIcon,
    to: '/receive',
    testID: ExploreSelectors.ReceiveButton
  },
  {
    type: 'faucet',
    label: t('faucet'),
    Icon: FaucetIcon,
    to: isMobile() ? undefined : '/faucet',
    onClick: isMobile() ? handleFaucetClick : undefined,
    testID: ExploreSelectors.FaucetButton
  }
];

export const ActionButtons = ({ address }: { address: string }) => {
  const { t } = useTranslation();
  const network = useNetwork();
  const handleFaucetClick = useCallback(async () => {
    const faucetUrl = getFaucetUrl(network.id);
    await openFaucetWebview({ url: faucetUrl, title: t('midenFaucet'), recipientAddress: address });
  }, [network.id, t, address]);

  return (
    <div className={classNames('flex w-full gap-3 items-center justify-evenly py-4 border-y border-grey-300/20')}>
      {ACTION_BUTTONS(t, handleFaucetClick).map(props => (
        <ActionButton key={props.type} {...props} />
      ))}
    </div>
  );
};
