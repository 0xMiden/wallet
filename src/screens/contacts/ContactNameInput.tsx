import React from 'react';

import { useTranslation } from 'react-i18next';

export const CONTACT_NAME_MAX_LENGTH = 50;

export const CONTACT_FIELD_CLASS =
  'w-full rounded-2xl bg-surface-input px-4 font-heading text-lg font-bold text-heading-gray outline-none placeholder:font-medium placeholder:text-text-muted';

interface ContactNameInputProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

/** The contact's name field, shared by the new-contact page and the contact's edit mode. */
export const ContactNameInput: React.FC<ContactNameInputProps> = ({ value, onChange, autoFocus }) => {
  const { t } = useTranslation();

  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm text-text-muted">{t('name')}</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={t('contactNamePlaceholder')}
        maxLength={CONTACT_NAME_MAX_LENGTH}
        autoFocus={autoFocus}
        autoCapitalize="words"
        autoCorrect="off"
        enterKeyHint="done"
        data-testid="address-book-name-input"
        className={`h-14 ${CONTACT_FIELD_CLASS}`}
      />
    </label>
  );
};
