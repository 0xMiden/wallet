import React, { ComponentProps, FC, useEffect, useRef } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import AddressShortView from 'app/atoms/AddressShortView';
import { Button } from 'app/atoms/Button';
import ColorIdenticon from 'app/atoms/ColorIdenticon';
import Name from 'app/atoms/Name';
import { TestIDProps } from 'lib/analytics';

import { SendFormSelectors } from '../SendForm.selectors';

type ContactsDropdownItemProps = ComponentProps<typeof Button> &
  TestIDProps & {
    active?: boolean;
  };

const ContactsDropdownItem: FC<ContactsDropdownItemProps> = ({ active, testID, testIDProperties, ...rest }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  }, [active]);

  return (
    <Button
      ref={ref}
      type="button"
      testID={testID ?? SendFormSelectors.ContactItemButton}
      testIDProperties={testIDProperties}
      className={classNames(
        'w-full flex items-center',
        'p-2 text-left',
        active ? 'bg-gray-100' : 'hover:bg-gray-100 focus:bg-gray-100'
      )}
      tabIndex={-1}
      {...rest}
    >
      {/* eslint-disable i18next/no-literal-string -- placeholder data, not user-facing text */}
      <ColorIdenticon publicKey={'contact.address'} className="shrink-0" />

      <div className="ml-3 flex flex-1 w-full">
        <div className="flex flex-col justify-between flex-1">
          <Name className="mb-px text-sm font-medium leading-tight text-left text-black">{'contact.name'}</Name>

          <span className={classNames('text-xs leading-tight text-black')}>
            <AddressShortView address={'contact.address'} />
            {/* eslint-enable i18next/no-literal-string */}
          </span>
        </div>

        <div className="flex items-center">
          <span
            className={classNames(
              'mx-1',
              'rounded-md',
              'border-2',
              'px-2 py-1',
              'leading-tight',
              'border-gray-800 bg-gray-800 text-black',
              'font-medium'
            )}
            style={{ fontSize: '0.6rem' }}
          >
            {t('ownAccount')}
          </span>
        </div>
      </div>
    </Button>
  );
};

export default ContactsDropdownItem;
