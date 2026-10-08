import React from 'react';

import { act, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import Dialogs from 'app/layouts/Dialogs';
import { externalPageFailed } from 'lib/mobile/external-page-failed';
import { DialogsProvider } from 'lib/ui/dialog';

import { ExternalPageFailedNotice } from './ExternalPageFailedNotice';
import en from '../../public/_locales/en/en.json';

// Native back plumbing is irrelevant here; the notice is shown through the real dialog store and sheet.
jest.mock('lib/mobile/useMobileBackHandler', () => ({
  useMobileBackHandler: jest.fn()
}));

describe('ExternalPageFailedNotice', () => {
  let testI18n: typeof i18n;

  beforeEach(async () => {
    testI18n = i18n.createInstance();
    await testI18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false, prefix: '$', suffix: '$' },
      resources: { en: { translation: en } }
    });
  });

  const Tree = ({ withNotice = true }: { withNotice?: boolean }) => (
    <I18nextProvider i18n={testI18n}>
      <DialogsProvider>
        <Dialogs />
        {withNotice && <ExternalPageFailedNotice />}
      </DialogsProvider>
    </I18nextProvider>
  );

  it('shows the localized notice when an external page failed to load', () => {
    render(<Tree />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    act(() => externalPageFailed());

    expect(screen.getByRole('alertdialog', { name: en.error })).toHaveAccessibleDescription(
      "Couldn't open this page. Check your connection and try again."
    );
  });

  it('stops listening once unmounted', () => {
    const { rerender } = render(<Tree />);
    rerender(<Tree withNotice={false} />);

    act(() => externalPageFailed());

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
