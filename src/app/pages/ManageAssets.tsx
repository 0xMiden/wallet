import React, { FC, memo, useCallback } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import Checkbox from 'app/atoms/Checkbox';
import { ReactComponent as AddIcon } from 'app/icons/add-to-list.svg';
import { ReactComponent as CloseIcon } from 'app/icons/close.svg';
import { ReactComponent as ControlCentreIcon } from 'app/icons/control-centre.svg';
import { ReactComponent as SearchIcon } from 'app/icons/search.svg';
import PageLayout from 'app/layouts/PageLayout';
import { AssetIcon } from 'app/templates/AssetIcon';
import SearchAssetField from 'app/templates/SearchAssetField';
import { AssetTypesEnum } from 'lib/miden/assets/types';
import { getAssetName, getAssetSymbol, useAssetMetadata } from 'lib/miden/front';
import { Link } from 'lib/woozie';

import styles from './ManageAssets.module.css';
import { ManageAssetsSelectors } from './ManageAssets.selectors';

interface Props {
  assetType: string;
}

const ManageAssets: FC<Props> = ({ assetType }) => {
  const { t } = useTranslation();
  return (
    <PageLayout
      pageTitle={
        <>
          <ControlCentreIcon className="w-auto h-4 mr-1 stroke-current" />
          {t(assetType === AssetTypesEnum.Collectibles ? 'manageCollectibles' : 'manageTokens')}
        </>
      }
    >
      <ManageAssetsContent assetType={assetType} />
    </PageLayout>
  );
};

export default ManageAssets;

const ManageAssetsContent: FC<Props> = ({ assetType }) => {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-sm mx-auto mb-6">
      <div className="mt-1 mb-3 w-full flex items-strech">
        <SearchAssetField value={'searchValue'} onValueChange={() => {}} />

        <Link
          to="/add-asset"
          className={classNames(
            'ml-2 shrink-0',
            'px-3 py-1',
            'rounded overflow-hidden',
            'flex items-center',
            'text-black text-sm',
            'transition ease-in-out duration-200',
            'hover:bg-gray-100',
            'opacity-75 hover:opacity-100 focus:opacity-100'
          )}
          testID={ManageAssetsSelectors.AddTokenButton}
        >
          <AddIcon className={classNames('mr-1 h-5 w-auto stroke-current stroke-2')} />
          {t(assetType === AssetTypesEnum.Collectibles ? 'addCollectible' : 'addToken')}
        </Link>
      </div>
      <LoadingComponent loading={true} searchValue={'searchValue'} assetType={assetType} />
    </div>
  );
};

type ListItemProps = {
  assetSlug: string;
  assetId: string;
  last: boolean;
  checked: boolean;
  onUpdate: (assetSlug: string, assetId: string) => void;
  assetType: string;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ListItem = memo<ListItemProps>(({ assetSlug, assetId, last, checked, onUpdate, assetType }) => {
  const { t } = useTranslation();
  const metadata = useAssetMetadata(assetSlug, assetId);

  const handleCheckboxChange = useCallback(
    (evt: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate(assetSlug, assetId);
    },
    [assetSlug, assetId, onUpdate]
  );

  return (
    <label
      className={classNames(
        'block w-full',
        'overflow-hidden',
        checked ? 'bg-gray-100' : 'hover:bg-gray-100 focus:bg-gray-100',
        'flex items-center py-2 px-3',
        'text-black',
        'transition ease-in-out duration-200',
        'focus:outline-none',
        'cursor-pointer'
      )}
    >
      <AssetIcon assetSlug={assetSlug} assetId={assetId} size={32} className="mr-3 shrink-0" />

      <div className={classNames('flex items-center', styles.tokenInfoWidth)}>
        <div className="flex flex-col items-start w-full">
          <div
            className={classNames('text-sm font-normal text-black truncate w-full')}
            style={{ marginBottom: '0.125rem' }}
          >
            {getAssetName(metadata)}
          </div>

          <div className={classNames('text-xs  text-black truncate w-full')}>{getAssetSymbol(metadata)}</div>
        </div>
      </div>

      <div className="flex-1" />

      <div
        className={classNames(
          'mr-2 p-1',
          'rounded-full',
          'text-gray-400 hover:text-black',
          'hover:bg-black hover:bg-opacity/5',
          'transition ease-in-out duration-200'
        )}
        onClick={evt => {
          evt.preventDefault();
          onUpdate(assetSlug, assetId);
        }}
      >
        <CloseIcon className="w-auto h-4 stroke-current stroke-2" title={t('delete')} />
      </div>

      <Checkbox checked={checked} onChange={handleCheckboxChange} />
    </label>
  );
});

interface LoadingComponentProps {
  loading: boolean;
  searchValue: string;
  assetType: string;
}

const LoadingComponent: React.FC<LoadingComponentProps> = ({ loading, searchValue, assetType }) => {
  const { t } = useTranslation();
  return loading ? null : (
    <div className={classNames('my-8', 'flex flex-col items-center justify-center', 'text-gray-500')}>
      <p className={classNames('mb-2', 'flex items-center justify-center', 'text-black text-black ')}>
        {Boolean(searchValue) && <SearchIcon className="w-5 h-auto mr-1 stroke-current" />}

        <span>{t('noAssetsFound')}</span>
      </p>

      <p className={classNames('text-center text-xs ')}>
        {t('ifYouDontSeeYourAsset', { toClick: <RenderAssetComponent assetType={assetType} /> })}
      </p>
    </div>
  );
};
const RenderAssetComponent: React.FC<{ assetType: string }> = ({ assetType }) => {
  const { t } = useTranslation();
  return <b>{t(assetType === AssetTypesEnum.Collectibles ? 'addCollectible' : 'addToken')}</b>;
};
