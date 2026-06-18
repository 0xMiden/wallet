import React, { FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as AddIcon } from 'app/icons/add-to-list.svg';
import { ReactComponent as ControlCentreIcon } from 'app/icons/control-centre.svg';
import { ReactComponent as SearchIcon } from 'app/icons/search.svg';
import PageLayout from 'app/layouts/PageLayout';
import SearchAssetField from 'app/templates/SearchAssetField';
import { AssetTypesEnum } from 'lib/miden/assets/types';
import { Link } from 'lib/woozie';

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
