import React, { ComponentProps, FC, HTMLAttributes } from 'react';

import CopyButton, { CopyButtonProps } from 'app/atoms/CopyButton';
import HashShortView from 'app/atoms/HashShortView';
import { Icon, IconName } from 'app/icons/v2';

type HashChipProps = HTMLAttributes<HTMLButtonElement> &
  ComponentProps<typeof HashShortView> &
  Pick<ComponentProps<typeof Icon>, 'size' | 'fill' | 'className'> &
  Pick<CopyButtonProps, 'small' | 'type' | 'bgShade' | 'rounded' | 'textShade'>;

const HashChip: FC<HashChipProps> = ({
  hash,
  trimHash,
  trimAfter,
  firstCharsCount,
  lastCharsCount,
  displayName,
  type = 'button',
  size = 'xs',
  fill = 'black',
  ...rest
}) => (
  <CopyButton text={hash} type={type} {...rest}>
    <span className="flex flex-row items-center">
      <HashShortView
        hash={hash}
        trimHash={trimHash}
        trimAfter={trimAfter}
        firstCharsCount={firstCharsCount}
        lastCharsCount={lastCharsCount}
        displayName={displayName}
      />
      <Icon name={IconName.Copy} size={size} fill={fill} />
    </span>
  </CopyButton>
);

export default HashChip;
