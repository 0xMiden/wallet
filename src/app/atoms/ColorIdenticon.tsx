import React, { FC, HTMLAttributes } from 'react';

import randomColor from 'randomcolor';

import { Avatar } from 'components/Avatar';

type ColorIdenticonProps = HTMLAttributes<HTMLDivElement> & {
  publicKey: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
};

const ColorIdenticon: FC<ColorIdenticonProps> = ({
  publicKey,
  size = 'md',
  className = 'm-auto',
  style = {},
  ...rest
}) => {
  const color = randomColor({ seed: publicKey });

  return (
    <Avatar className={className} style={{ backgroundColor: color }} size={size} image="/misc/avatars/miden-logo.svg" />
  );
};

export default ColorIdenticon;
