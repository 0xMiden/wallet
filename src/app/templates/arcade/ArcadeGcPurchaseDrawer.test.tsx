import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { GcSale } from 'lib/miden/arcade/gc-sale';

import { ArcadeGcPurchaseDrawer } from './ArcadeGcPurchaseDrawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));
jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (a: string, b: string) => a === b }));
jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

// Keep the real fields and actions. Replace only the native sheet boundary.
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

const small: GcSale = {
  saleNoteId: 'cheap-small',
  sellerAccountId: 'seller-small',
  gcFaucetId: 'gc',
  payFaucetId: 'usdcx',
  offeredAmount: 2_000_000n,
  requestedAmount: 1_000n,
  fillFloor: 0n
};
const large: GcSale = {
  ...small,
  saleNoteId: 'large',
  sellerAccountId: 'seller-large',
  offeredAmount: 100_000_000n,
  requestedAmount: 100_000n
};

function showDrawer() {
  const onConfirm = jest.fn();
  render(
    <ArcadeGcPurchaseDrawer
      open
      onOpenChange={jest.fn()}
      sale={small}
      sales={[large, small]}
      payBalance={1_000_000n}
      submitting={false}
      error={null}
      onConfirm={onConfirm}
    />
  );
  return onConfirm;
}

it('selects the cheapest sale, then changes the seller when the entered amount needs more inventory', () => {
  const onConfirm = showDrawer();
  fireEvent.click(screen.getByTestId('arcade-gc-purchase-confirm'));
  expect(onConfirm).toHaveBeenLastCalledWith(expect.objectContaining({ saleNoteId: 'cheap-small', fillAmount: 500n }));
  fireEvent.change(screen.getByTestId('arcade-gc-purchase-amount'), { target: { value: '10' } });
  fireEvent.click(screen.getByTestId('arcade-gc-purchase-confirm'));
  expect(onConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      saleNoteId: 'large',
      sellerAccountId: 'seller-large',
      fillAmount: 10_000n,
      expectedAmount: 10_000_000n
    })
  );
});

it('disables confirmation for invalid amounts or when no single sale can supply the amount', () => {
  const onConfirm = showDrawer();
  for (const value of ['0', '0.0000001', '101']) {
    fireEvent.change(screen.getByTestId('arcade-gc-purchase-amount'), { target: { value } });
    expect(screen.getByTestId('arcade-gc-purchase-confirm')).toBeDisabled();
  }
  expect(onConfirm).not.toHaveBeenCalled();
});
