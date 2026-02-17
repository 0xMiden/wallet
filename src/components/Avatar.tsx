import React, { useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import Identicon from 'app/atoms/Identicon';
import { CollectiblePlaceholder } from 'app/icons';

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
  isCollectible?: boolean;
  image?: string;
  identiconPublicKey?: string;
}

const classPerSize = {
  xs: 'w-4 h-4',
  sm: 'w-5 h-5',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
  xl: 'w-12 h-12',
  xxl: 'w-16 h-16'
};

export const Avatar: React.FC<AvatarProps> = ({
  className,
  size = 'md',
  image,
  isCollectible,
  identiconPublicKey,
  ...props
}) => {
  const { t } = useTranslation();
  const imageComponent = useCallback(() => {
    if (image) {
      return <img src={image} alt={t('avatar')} className={classNames('')} />;
    }

    if (!image && isCollectible) {
      <CollectiblePlaceholder />;
    }

    if (identiconPublicKey) {
      return <Identicon type="initials" publicKey={identiconPublicKey} size={32} />;
    }

    return null;
  }, [image, identiconPublicKey, isCollectible, t]);
  return (
    <div {...props} className={classNames('rounded-[3.21px] overflow-hidden', classPerSize[size], className)}>
      {imageComponent()}
    </div>
  );
};
