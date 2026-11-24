import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import type { GcSale } from 'lib/miden/arcade/gc-sale';

import { ArcadeGcPurchaseDrawer } from './ArcadeGcPurchaseDrawer';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { amount?: string }) =>
      options?.amount === undefined ? key : `${key} ${options.amount}`
  })
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

const packageSale: GcSale = {
  saleNoteId: 'exact-package',
  sellerAccountId: 'seller',
  gcFaucetId: 'gc',
  payFaucetId: 'usdcx',
  offeredAmount: 1_000_000_000n,
  requestedAmount: 1_000_000n,
  fillFloor: 0n
};

const smallSale: GcSale = {
  ...packageSale,
  saleNoteId: 'small-sale',
  offeredAmount: 500_000_000n,
  requestedAmount: 500_000n
};

function showDrawer(sales: GcSale[], payBalance: bigint = 10_000_000n) {
  const onConfirm = jest.fn();
  render(
    <ArcadeGcPurchaseDrawer
      open
      onOpenChange={jest.fn()}
      sale={sales[0] ?? null}
      sales={sales}
      payBalance={payBalance}
      submitting={false}
      error={null}
      onConfirm={onConfirm}
    />
  );
  return onConfirm;
}

it('confirms exactly one USDCx principal for one thousand GC with a separate network fee', () => {
  const onConfirm = showDrawer([packageSale]);

  expect(screen.getByText('arcadeGcPurchaseFeeSeparate')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('arcade-gc-purchase-confirm'));

  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm).toHaveBeenCalledWith(
    expect.objectContaining({ saleNoteId: 'exact-package', fillAmount: 1_000_000n, expectedAmount: 1_000_000_000n })
  );
});

it('does not offer an editable purchase amount', () => {
  showDrawer([packageSale]);

  expect(screen.queryByTestId('arcade-gc-purchase-amount')).toBeNull();
});

it('disables confirmation when the available sale cannot back the whole package', () => {
  const onConfirm = showDrawer([smallSale]);

  expect(screen.getByTestId('arcade-gc-purchase-confirm')).toBeDisabled();
  expect(onConfirm).not.toHaveBeenCalled();
});

it('selects an exact package instead of a differently priced sale', () => {
  const lowerPrice: GcSale = { ...packageSale, saleNoteId: 'lower-price', requestedAmount: 999_999n };
  const onConfirm = showDrawer([lowerPrice, packageSale]);

  fireEvent.click(screen.getByTestId('arcade-gc-purchase-confirm'));

  expect(onConfirm).toHaveBeenCalledWith(
    expect.objectContaining({ saleNoteId: 'exact-package', fillAmount: 1_000_000n, expectedAmount: 1_000_000_000n })
  );
});

it('disables confirmation when the balance cannot cover the package principal', () => {
  const onConfirm = showDrawer([packageSale], 999_999n);

  expect(screen.getByTestId('arcade-gc-purchase-confirm')).toBeDisabled();
  expect(onConfirm).not.toHaveBeenCalled();
});
