import React, { FC } from 'react';

import { Icon, IconName } from 'app/icons/v2';
import { ListGroup } from 'components/ui/ListGroup';
import { ListRow } from 'components/ui/ListRow';
import { SubPageLayout } from 'components/ui/SubPageLayout';
import { useNetwork, useSetNetworkId } from 'lib/miden/front';
import { NETWORKS } from 'lib/miden/networks';

const NetworksSettings: FC = () => {
  const setNetworkId = useSetNetworkId();
  const network = useNetwork();

  return (
    <SubPageLayout data-testid="networks-settings">
      <ListGroup>
        {NETWORKS.map(item => (
          <ListRow
            key={item.id}
            title={item.name}
            icon={<Icon name={IconName.MidenLogo} />}
            checked={network.id === item.id}
            onClick={() => setNetworkId(item.id)}
            data-testid={`networks-${item.id}`}
          />
        ))}
      </ListGroup>
    </SubPageLayout>
  );
};

export default NetworksSettings;
