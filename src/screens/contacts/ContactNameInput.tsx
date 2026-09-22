import React from 'react';

import { useTranslation } from 'react-i18next';

import { TextField } from 'components/ui/TextField';

export const CONTACT_NAME_MAX_LENGTH = 50;

interface ContactNameInputProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

/** The contact's name field, shared by the new-contact page and the contact's edit mode. */
export const ContactNameInput: React.FC<ContactNameInputProps> = ({ value, onChange, autoFocus }) => {
  const { t } = useTranslation();

  return (
    <TextField
      label={t('name')}
      value={value}
      onChange={event => onChange(event.target.value)}
      placeholder={t('contactNamePlaceholder')}
      maxLength={CONTACT_NAME_MAX_LENGTH}
      autoFocus={autoFocus}
      autoCapitalize="words"
      autoCorrect="off"
      enterKeyHint="done"
      data-testid="address-book-name-input"
    />
  );
};
