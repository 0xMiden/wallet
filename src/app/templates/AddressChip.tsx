import React, { ComponentProps, FC, HTMLAttributes } from 'react';

import AddressShortView from 'app/atoms/AddressShortView';
import CopyButton, { CopyButtonProps } from 'app/atoms/CopyButton';
import { Icon, IconName } from 'app/icons/v2';

type AddressChipProps = HTMLAttributes<HTMLButtonElement> &
  ComponentProps<typeof AddressShortView> &
  Pick<ComponentProps<typeof Icon>, 'size' | 'fill' | 'className'> &
  Pick<CopyButtonProps, 'small' | 'type' | 'bgShade' | 'rounded' | 'textShade'> & { copyIcon?: boolean };

const AddressChip: FC<AddressChipProps> = ({
  address,
  displayName,
  trim,
  type = 'button',
  size = 'xs',
  className = 'ml-4',
  copyIcon = true,
  ...rest
}) => (
  <CopyButton text={address} type={type} {...rest} className="p-0!">
    <span className="flex flex-row items-center">
      <span className="mr-1 break-all text-heading-gray text-xs leading-none font-medium opacity-64">
        <AddressShortView address={address} displayName={displayName} trim={trim} />
      </span>
      {copyIcon && <Icon name={IconName.Copy} size={size} className={className} />}
    </span>
  </CopyButton>
);

export default AddressChip;
