import React, { ComponentProps, FC } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import FormField from 'app/atoms/FormField';
import { ReactComponent as CopyIcon } from 'app/icons/copy.svg';
import useCopyToClipboard from 'lib/ui/useCopyToClipboard';

type AssetInfoProps = {
  assetSlug: string;
};

const AssetInfo: FC<AssetInfoProps> = ({ assetSlug }) => {
  const { t } = useTranslation();
  const asset = assetSlug;

  return (
    <div className={classNames('w-full max-w-sm mx-auto')}>
      <InfoField
        textarea
        rows={2}
        id="contract-address"
        label={t('contract')}
        labelDescription={t('addressOfTokenContract', { assetSymbol: 'TODO' })}
        value={asset}
        size={36}
        style={{
          resize: 'none'
        }}
      />

      <InfoField id="token-decimals" label={t('decimals')} value={420} />
    </div>
  );
};

export default AssetInfo;

type InfoFieldProps = ComponentProps<typeof FormField>;

const InfoField: FC<InfoFieldProps> = props => {
  const { t } = useTranslation();
  const { fieldRef, copy, copied } = useCopyToClipboard();

  return (
    <>
      <FormField ref={fieldRef} spellCheck={false} readOnly {...props} />

      <button
        type="button"
        className={classNames(
          'mx-auto mb-6',
          'py-1 px-2 w-40',
          'bg-primary-orange rounded',
          'border border-primary-orange',
          'flex items-center justify-center',
          'text-primary-orange-lighter text-shadow-black-orange',
          'text-sm font-semibold',
          'transition duration-300 ease-in-out',
          'opacity-90 hover:opacity-100 focus:opacity-100',
          'shadow-sm',
          'hover:shadow focus:shadow'
        )}
        onClick={copy}
      >
        {copied ? (
          t('copiedAddress')
        ) : (
          <>
            <CopyIcon className={classNames('mr-1', 'h-4 w-auto', 'stroke-current stroke-2')} />
            {t('copyAddressToClipboard')}
          </>
        )}
      </button>
    </>
  );
};
