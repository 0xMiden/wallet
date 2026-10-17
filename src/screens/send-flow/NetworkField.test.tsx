import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { NetworkField } from './NetworkField';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('./bridge-networks', () => ({ BRIDGE_NETWORKS: [] }));
const networks = [
  { id: 'base', name: 'Base', chainId: 8453 },
  { id: 'arbitrum', name: 'Arbitrum', chainId: 42161 }
];

it('opens the destination list, changes network and closes the picker', () => {
  const select = jest.fn();
  render(<NetworkField chain="ethereum" networks={networks} network="base" onSelect={select} testIdPrefix="send" />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('send-network-picker'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByTestId('send-network-base')).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByTestId('send-network-arbitrum'));
  expect(select).toHaveBeenCalledWith('arbitrum');
  expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'closed');
});

it('shows a single available destination as a fact', () => {
  render(
    <NetworkField
      chain="ethereum"
      networks={networks.slice(0, 1)}
      network="base"
      onSelect={jest.fn()}
      testIdPrefix="send"
    />
  );
  expect(screen.getByTestId('send-network-base')).toHaveTextContent('Base');
  expect(screen.queryByTestId('send-network-picker')).not.toBeInTheDocument();
});

it('closes a nested network picker while preserving its parent sheet', () => {
  render(
    <Drawer open onOpenChange={jest.fn()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Contact</DrawerTitle>
        </DrawerHeader>
        <NetworkField chain="ethereum" networks={networks} network="base" onSelect={jest.fn()} testIdPrefix="contact" />
      </DrawerContent>
    </Drawer>
  );
  fireEvent.click(screen.getByTestId('contact-network-picker'));
  expect(screen.getByRole('dialog', { name: 'selectNetwork' })).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('contact-network-arbitrum'));
  expect(screen.getByText('Contact').closest('[role="dialog"]')).toHaveAttribute('data-state', 'open');
  expect(screen.getByRole('dialog', { name: 'selectNetwork' })).toHaveAttribute('data-state', 'closed');
});
