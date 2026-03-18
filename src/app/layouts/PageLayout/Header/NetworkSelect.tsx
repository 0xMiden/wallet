import React, { FC, HTMLAttributes } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { Button } from 'app/atoms/Button';
import DropdownWrapper from 'app/atoms/DropdownWrapper';
import Name from 'app/atoms/Name';
import { ReactComponent as SignalAltIcon } from 'app/icons/signal-alt.svg';
import { useNetwork } from 'lib/miden/front';
import { NETWORKS } from 'lib/miden/networks';
import Popper from 'lib/ui/Popper';

import styles from './NetworkSelect.module.css';
import { NetworkSelectSelectors } from './NetworkSelect.selectors';

type NetworkSelectProps = HTMLAttributes<HTMLDivElement>;

const NetworkSelect: FC<NetworkSelectProps> = () => {
  const { t } = useTranslation();
  const network = useNetwork();
  const uiNetwork = NETWORKS.find(n => n.id === network.id)!;

  return (
    <Popper
      placement="bottom-end"
      strategy="fixed"
      popup={({ opened, setOpened }) => (
        <DropdownWrapper opened={opened} className="origin-top-right">
          <div className={styles.scroll}>
            <h2
              className={classNames(
                'mb-2',
                'border-b border-primary-500',
                'px-1 py-2',
                'flex items-center',
                'text-black font-medium text-sm text-center'
              )}
            >
              <SignalAltIcon className="w-auto h-4 mr-1 stroke-current" />
              {t('networks')}
            </h2>
          </div>
        </DropdownWrapper>
      )}
    >
      {({ ref, opened, toggleOpened }) => (
        <Button
          ref={ref}
          className={classNames(
            'text-black',
            'hover:bg-gray-100',
            'active:bg-gray-200',
            'transition ease-in-out duration-200',
            'px-2',
            opened ? 'opacity-100' : 'opacity-90 hover:opacity-100 focus:opacity-100',
            'flex items-center text-[10px] leading-4 gap-2',
            'select-none border border-grey-200 rounded-3xl'
          )}
          // Disabled until we redo screen & add more networks
          // onClick={toggleOpened}
          testID={NetworkSelectSelectors.SelectedNetworkButton}
        >
          <div className={classNames('h-2 w-2', 'rounded-full', 'shadow-xs', 'bg-green-500 border-none')} />
          <Name style={{ maxWidth: '7rem' }}>{uiNetwork.name}</Name>
        </Button>
      )}
    </Popper>
  );
};

export default NetworkSelect;
