import React, { FC } from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { CardItem } from 'components/CardItem';
import { useNetwork, useSetNetworkId } from 'lib/miden/front';
import { NETWORKS } from 'lib/miden/networks';

const NetworksSettings: FC = () => {
  const setNetworkId = useSetNetworkId();
  const network = useNetwork();

  const onNetworkSelect = async (networkId: string) => {
    setNetworkId(networkId);
  };

  return (
    <div className="flex justify-center py-6">
      <div className="flex flex-col w-[328px] gap-y-4">
        <ul className="flex flex-col gap-y-4">
          {NETWORKS.map(item => (
            <CardItem
              key={item.id}
              title={item.name}
              className="hover:bg-grey-50 cursor-pointer"
              iconLeft={
                <div className="bg-black rounded-full w-8 h-8 flex items-center justify-center p-2">
                  <Icon name={IconName.MidenLogoWhite} />
                </div>
              }
              iconRight={network.id === item.id ? IconName.CheckboxCircleFill : null}
              onClick={() => onNetworkSelect(item.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
};

export default NetworksSettings;
