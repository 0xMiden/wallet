import React, { ComponentProps, FC, HTMLAttributes } from 'react';

import AddressShortView from 'app/atoms/AddressShortView';
import CopyButton, { CopyButtonProps } from 'app/atoms/CopyButton';
import { Icon, IconName } from 'app/icons/v2';

type AddressChipProps = HTMLAttributes<HTMLButtonElement> &
  ComponentProps<typeof AddressShortView> &
  Pick<ComponentProps<typeof Icon>, 'size' | 'fill' | 'className'> &
  Pick<CopyButtonProps, 'small' | 'type' | 'bgShade' | 'rounded' | 'textShade'>;

const AddressChip: FC<AddressChipProps> = ({
  address,
  displayName,
  trim,
  type = 'button',
  size = 'xs',
  fill = 'black',
  className = 'ml-4',
  ...rest
}) => (
  <CopyButton text={address} type={type} {...rest} className="pt-2.25! pb-0! pl-4!">
    <span className="flex flex-row items-center">
      <span className="mr-1 break-all text-heading-gray">
        <AddressShortView address={address} displayName={displayName} trim={trim} />
      </span>
      <Icon name={IconName.Copy} size={size} fill={fill} className={className} />
    </span>
  </CopyButton>
);

export default AddressChip;
