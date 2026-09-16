import React, { useEffect, useState, useMemo, memo } from 'react';

import classNames from 'clsx';
import { useTranslation } from 'react-i18next';

import { ReactComponent as ContactBookIcon } from 'app/icons/contact-book.svg';
import { TestIDProps } from 'lib/ui/test-id.props';

import ContactsDropdownItem from './ContactsDropdownItem';

export type ContactsDropdownProps = TestIDProps & {
  onSelect: (address: string) => void;
  searchTerm: string;
  fullPage: boolean;
};

const ContactsDropdown = memo<ContactsDropdownProps>(({ onSelect, searchTerm, fullPage, testID, testIDProperties }) => {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const filteredContacts: any[] = useMemo(() => [], []);

  const activeItem = useMemo(
    () => (activeIndex !== null ? filteredContacts[activeIndex] : null),
    [filteredContacts, activeIndex]
  );

  useEffect(() => {
    setActiveIndex(i => getSearchTermIndex(i, searchTerm));
  }, [setActiveIndex, searchTerm]);

  useEffect(() => {
    if (activeIndex !== null && activeIndex >= filteredContacts.length) {
      setActiveIndex(null);
    }
  }, [setActiveIndex, activeIndex, filteredContacts.length]);

  useEffect(() => {
    const keyHandler = (evt: KeyboardEvent) => handleKeyup(evt, activeItem, onSelect, setActiveIndex);
    window.addEventListener('keyup', keyHandler);
    return () => window.removeEventListener('keyup', keyHandler);
  }, [activeItem, setActiveIndex, onSelect]);

  return (
    <div
      className={classNames('overflow-x-hidden overflow-y-auto', 'z-50 rounded-lg', 'overscroll-contain')}
      style={{
        top: '100%',
        height: fullPage ? '9rem' : '5rem',
        backgroundColor: 'white',
        padding: 0
      }}
    >
      {filteredContacts.length > 0 ? (
        filteredContacts.map(contact => (
          <ContactsDropdownItem
            key={contact.address}
            active={contact.address === activeItem?.address}
            onMouseDown={() => onSelect(contact.address)}
            testID={testID}
            testIDProperties={testIDProperties}
          />
        ))
      ) : (
        <div className={classNames('flex items-center justify-start my-6', 'text-black text-black')}>
          <ContactBookIcon className="w-5 h-auto mr-1 stroke-current" />
          <span>{t('noContactsFound')}</span>
        </div>
      )}
    </div>
  );
});

export default ContactsDropdown;

const getSearchTermIndex = (i: number | null, searchTerm: string) => (searchTerm ? getDefinedIndex(i) : i);
const getDefinedIndex = (i: number | null) => (i !== null ? i : 0);
const getMinimumIndex = (i: number | null) => (i !== null ? i + 1 : 0);
const getMaximumIndex = (i: number | null) => {
  if (i === null) return i;
  return i > 0 ? i - 1 : 0;
};

const handleKeyup = (
  evt: KeyboardEvent,
  activeItem: null,
  onSelect: (address: string) => void,
  setActiveIndex: (value: React.SetStateAction<number | null>) => void
) => {
  switch (evt.key) {
    case 'Enter':
      if (activeItem) {
        onSelect('activeItem.address');
        (document.activeElement as any)?.blur();
      }
      break;

    case 'ArrowDown':
      setActiveIndex(i => getMinimumIndex(i));
      break;

    case 'ArrowUp':
      setActiveIndex(i => getMaximumIndex(i));
      break;
  }
};
