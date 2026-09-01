import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { MarkAsSpamDrawer } from './MarkAsSpamDrawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('lib/i18n/numbers', () => ({
  formatBigInt: (amount: bigint, decimals: number) => (Number(amount) / 10 ** decimals).toString()
}));

jest.mock('lib/ui/drawer', () => {
  const passthrough =
    (testId: string) =>
    ({ children }: { children?: React.ReactNode }) => <div data-testid={testId}>{children}</div>;
  return {
    Drawer: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div data-testid="drawer">{children}</div> : null,
    DrawerContent: passthrough('drawer-content'),
    DrawerHeader: passthrough('drawer-header'),
    DrawerFooter: passthrough('drawer-footer'),
    DrawerTitle: passthrough('drawer-title'),
    DrawerDescription: passthrough('drawer-description')
  };
});

jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost', Danger: 'danger' },
  Button: ({ title, onClick, ...props }: { title?: string; onClick?: () => void; 'data-testid'?: string }) => (
    <button data-testid={props['data-testid']} onClick={onClick}>
      {title}
    </button>
  )
}));

const note = {
  id: 'n1',
  faucetId: 'faucet-a',
  senderAddress: 'mtst1qqqqqqqqqqqqsender7x2f',
  amount: '50000',
  metadata: { symbol: 'MDN', decimals: 6, name: 'Miden' }
};

const renderDrawer = (over: Partial<React.ComponentProps<typeof MarkAsSpamDrawer>> = {}) => {
  const onConfirm = jest.fn();
  const onOpenChange = jest.fn();
  render(
    <MarkAsSpamDrawer
      open
      onOpenChange={onOpenChange}
      note={note}
      isNativeFaucet={false}
      onConfirm={onConfirm}
      {...over}
    />
  );
  return { onConfirm, onOpenChange };
};

describe('MarkAsSpamDrawer', () => {
  it('offers block-asset, block-sender-and-asset and cancel for a non-native note', () => {
    renderDrawer();
    expect(screen.getByTestId('spam-block-asset')).toBeInTheDocument();
    expect(screen.getByTestId('spam-block-sender-and-asset')).toBeInTheDocument();
    expect(screen.getByTestId('spam-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('spam-block-sender')).not.toBeInTheDocument();
    expect(screen.getByTestId('drawer-description')).toHaveTextContent('markAsSpamBody');
  });

  it('offers only block-sender and cancel for a native MIDEN note', () => {
    renderDrawer({ isNativeFaucet: true });
    expect(screen.getByTestId('spam-block-sender')).toBeInTheDocument();
    expect(screen.queryByTestId('spam-block-asset')).not.toBeInTheDocument();
    expect(screen.queryByTestId('spam-block-sender-and-asset')).not.toBeInTheDocument();
    expect(screen.getByTestId('drawer-description')).toHaveTextContent('markAsSpamBodyNative');
  });

  it('emits the matching SpamAction and closes', () => {
    const { onConfirm, onOpenChange } = renderDrawer();
    fireEvent.click(screen.getByTestId('spam-block-sender-and-asset'));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'block-sender-and-faucet',
      senderAddress: note.senderAddress,
      faucetId: note.faucetId
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByTestId('spam-block-asset'));
    expect(onConfirm).toHaveBeenLastCalledWith({ kind: 'block-faucet', faucetId: note.faucetId });
  });

  it('block-sender on a native note emits block-sender', () => {
    const { onConfirm } = renderDrawer({ isNativeFaucet: true });
    fireEvent.click(screen.getByTestId('spam-block-sender'));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'block-sender', senderAddress: note.senderAddress });
  });

  it('cancel closes without confirming; shows amount and sender', () => {
    const { onConfirm, onOpenChange } = renderDrawer();
    expect(screen.getByText('0.05 MDN')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('spam-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
