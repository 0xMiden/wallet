import React from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StorageRecoveryPage } from './StorageRecoveryPage';

const mockRecover = jest.fn();
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({
    ready: true,
    storageAvailability: { status: 'unavailable', epoch: 1 },
    recoverWalletStorage: mockRecover
  })
}));
jest.mock('lib/mobile/useMobileBackHandler', () => ({ useMobileBackHandler: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('screens/storage-recovery/RecoveryDataFlow', () => ({ RecoveryDataFlow: () => null }));
jest.mock('components/ui/SubPageLayout', () => ({
  SubPageLayout: ({ children }: { children?: React.ReactNode }) => <main>{children}</main>,
  SubPageSection: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>
}));
jest.mock('components/ui/Button', () => ({
  Button: ({
    children,
    title,
    onClick,
    disabled
  }: {
    children?: React.ReactNode;
    title?: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children ?? title}
    </button>
  ),
  ButtonVariant: { Secondary: 'secondary' }
}));

beforeEach(() => mockRecover.mockReset());

it('announces a failed check before the recovery actions', async () => {
  mockRecover.mockRejectedValueOnce(new Error('fixture failure'));
  render(<StorageRecoveryPage />);
  fireEvent.click(screen.getByRole('button', { name: 'storageRecoveryCheck' }));
  const status = screen.getByRole('status');
  await waitFor(() => expect(status).toHaveTextContent('storageRecoveryFailed'));
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(
    status.compareDocumentPosition(screen.getByRole('button', { name: 'storageRecoveryCheck' })) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
});
