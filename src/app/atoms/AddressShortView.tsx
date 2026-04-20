import React, { memo } from 'react';

import { truncateAddress } from 'utils/string';

type AddressShortViewProps = {
  address: string;
  trim?: boolean;
  displayName?: string;
};

const AddressShortView = memo<AddressShortViewProps>(({ address, displayName, trim = true }) => {
  if (!address) return null;

  const trimmedDisplayValue = (() => {
    if (displayName) return displayName;
    if (!trim) return address;

    return truncateAddress(address, false, 8);
  })();

  return <>{trimmedDisplayValue}</>;
});

export default AddressShortView;
