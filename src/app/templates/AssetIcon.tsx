import React, { FC, useState } from 'react';

import classNames from 'clsx';

import { Icon, IconName } from 'app/icons/v2';
import { formatAssetUri } from 'lib/image-uri';
import { AssetMetadata, useAssetMetadata } from 'lib/miden/front';

interface AssetIconPlaceholderProps {
  metadata: AssetMetadata | null;
  size?: number;
}

const AssetIconPlaceholder: FC<AssetIconPlaceholderProps> = () => {
  return <Icon name={IconName.MidenLogo} size="lg" />;
};

interface AssetIconProps {
  assetSlug: string;
  assetId: string;
  className?: string;
  size?: number;
}

interface LoadStrategy {
  type: string;
  formatUriFn: (value: string) => string;
  field: 'thumbnailUri' | 'artifactUri' | 'displayUri' | 'assetSlug';
}

const tokenLoadStrategy: Array<LoadStrategy> = [
  { type: 'thumbnailUri', formatUriFn: formatAssetUri, field: 'thumbnailUri' }
];

type ImageRequestObject = (AssetMetadata | null) & { assetSlug: string };

const getFirstFallback = (
  strategy: Array<LoadStrategy>,
  currentState: Record<string, boolean>,
  metadata: ImageRequestObject
): LoadStrategy => {
  for (const strategyItem of strategy) {
    if (metadata && metadata[strategyItem.field] && !currentState[strategyItem.type]) {
      return strategyItem;
    }
  }
  return strategy[0]!;
};

export const AssetIcon: FC<AssetIconProps> = ({ assetSlug, assetId, className, size }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const metadata: AssetMetadata | null = useAssetMetadata(assetSlug, assetId);
  const loadStrategy = tokenLoadStrategy;
  const [isLoadingFailed, setIsLoadingFailed] = useState(
    loadStrategy.reduce<Record<string, boolean>>((acc, cur) => ({ ...acc, [cur.type]: false }), {})
  );

  const imageRequestObject: ImageRequestObject = { ...metadata, assetSlug };
  const currentFallback = getFirstFallback(loadStrategy, isLoadingFailed, imageRequestObject);
  const imageSrc = currentFallback.formatUriFn(imageRequestObject[currentFallback.field] ?? assetSlug);

  const handleLoad = () => setIsLoaded(true);
  const handleError = () => setIsLoadingFailed(prevState => ({ ...prevState, [currentFallback.type]: true }));

  return (
    <div
      className={classNames('flex items-center justify-center', className)}
      style={{
        border: '1px solid #E9EBEF',
        borderRadius: '20px',
        width: '36px',
        height: '36px'
      }}
    >
      {imageSrc !== '' && (
        <img
          src={imageSrc}
          alt={metadata?.symbol}
          style={{
            ...(!isLoaded ? { display: 'none' } : {}),
            objectFit: 'contain',
            maxWidth: `100%`,
            maxHeight: `100%`
          }}
          height={size}
          width={size}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
      {(!isLoaded || !metadata || imageSrc === '') && <AssetIconPlaceholder metadata={metadata} size={size} />}
    </div>
  );
};
