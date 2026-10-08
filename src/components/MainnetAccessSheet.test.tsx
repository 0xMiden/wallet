import React, { useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import type { MainnetAccessOutcome } from 'lib/mainnet-access';

import { MainnetAccessSheet } from './MainnetAccessSheet';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key)
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

const mockHideForegroundDapp = jest.fn();
jest.mock('app/providers/DappBrowserProvider', () => ({
  useHideForegroundDappWhileOpen: (open: boolean) => mockHideForegroundDapp(open)
}));

// Vaul renders through a portal that jsdom cannot drive. A flat stand-in that renders its children
// only while open is sufficient for the open and close wiring.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div>
        <button type="button" aria-label="close" onClick={() => onOpenChange?.(false)} />
        {children}
      </div>
    ) : null,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

const onSubmit = jest.fn<Promise<MainnetAccessOutcome>, [string]>();

const Harness: React.FC = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)} />
      <MainnetAccessSheet open={open} onOpenChange={setOpen} onSubmit={onSubmit} />
    </>
  );
};

const code = () => screen.getByTestId('mainnet-access-code');
const cta = () => screen.getByTestId('mainnet-access-cta');
const type = (value: string) => fireEvent.change(code(), { target: { value } });
const submit = async () => {
  await act(async () => {
    fireEvent.submit(screen.getByTestId('mainnet-access-sheet'));
  });
};

describe('MainnetAccessSheet', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    onSubmit.mockReset();
    mockHideForegroundDapp.mockClear();
  });

  it('asks for the access code and names the network the user can stay on', () => {
    render(<Harness />);

    expect(screen.getByRole('heading')).toHaveTextContent('switchToMainnet');
    expect(screen.getByText('mainnetAccessDescription')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'mainnetAccessCodeLabel' })).toHaveAttribute('maxlength', '12');
    expect(screen.getByText('mainnetAccessNoCode:testnet')).toBeInTheDocument();
  });

  it('submits a 12-character code with letter case preserved', async () => {
    onSubmit.mockResolvedValue('granted');
    render(<Harness />);
    type('8gKIgL0O6Hc');
    expect(cta()).toBeDisabled();
    type('8gKIgL0O6HcU');
    expect(cta()).toBeEnabled();
    await submit();
    expect(onSubmit).toHaveBeenCalledWith('8gKIgL0O6HcU');
  });

  it('renders nothing on mainnet, even when asked to open', () => {
    mockNetworkKey = null;
    render(<Harness />);

    expect(screen.queryByTestId('mainnet-access-sheet')).not.toBeInTheDocument();
  });

  it('keeps the action disabled until the code has all eight digits', () => {
    render(<Harness />);
    expect(cta()).toBeDisabled();

    type('4729183');
    expect(cta()).toBeDisabled();

    type('47291835');
    expect(cta()).toBeEnabled();
  });

  it('does not check a code that is not complete', async () => {
    render(<Harness />);
    type('4729');

    await submit();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes when the code is granted', async () => {
    onSubmit.mockResolvedValue('granted');
    render(<Harness />);
    type('47291835');

    await submit();

    expect(onSubmit).toHaveBeenCalledWith('47291835');
    expect(screen.queryByTestId('mainnet-access-sheet')).not.toBeInTheDocument();
  });

  it('stays open and shows the refusal when the code is rejected, until the code changes', async () => {
    onSubmit.mockResolvedValue('rejected');
    render(<Harness />);
    type('47291835');

    await submit();

    expect(screen.getByRole('alert')).toHaveTextContent('mainnetAccessCodeRejected');
    expect(code()).toHaveAttribute('aria-invalid', 'true');

    type('4729183');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a different message when the check itself fails', async () => {
    onSubmit.mockRejectedValue(new Error('offline'));
    render(<Harness />);
    type('47291835');

    await submit();

    expect(screen.getByRole('alert')).toHaveTextContent('mainnetAccessCheckFailed');
    expect(cta()).toBeEnabled();
  });

  it('starts empty when it opens again', async () => {
    onSubmit.mockResolvedValue('rejected');
    render(<Harness />);
    type('47291835');
    await submit();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    fireEvent.click(screen.getByTestId('opener'));

    expect(code()).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides a foreground dApp while it is open', () => {
    render(<Harness />);

    expect(mockHideForegroundDapp).toHaveBeenLastCalledWith(true);
  });
});
