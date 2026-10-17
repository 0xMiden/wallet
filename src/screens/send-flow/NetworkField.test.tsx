import React, { useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';

import { NetworkField } from './NetworkField';
import { selectContactNetwork, type ContactNetworkPage } from '../../../playwright/e2e/helpers/contact-network';

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

// Adapt the driver's locator boundary to the real rendered component. The helper must open the
// nested sheet and change React state; a click that leaves the previous network cannot pass.
const contactPage: ContactNetworkPage = {
  getByTestId: id => ({
    isVisible: async () => {
      const element = screen.queryByTestId(id);
      return element !== null && !element.closest('[data-state="closed"]');
    },
    waitFor: async ({ state } = {}) => {
      await waitFor(() => {
        const element = screen.queryByTestId(id);
        if (state === 'hidden') {
          expect(element === null || element.closest('[data-state="closed"]') !== null).toBe(true);
        } else {
          expect(element).toBeVisible();
          expect(element?.closest('[data-state="closed"]')).toBeNull();
        }
      });
    },
    textContent: async () => screen.queryByTestId(id)?.textContent ?? null,
    click: async () => {
      await act(async () => {
        fireEvent.click(screen.getByTestId(id));
      });
    }
  })
};

function ContactNetworkFixture({
  chain = 'ethereum',
  single = false
}: {
  chain?: 'miden' | 'ethereum';
  single?: boolean;
}) {
  const [network, setNetwork] = useState('base');
  return (
    <NetworkField
      chain={chain}
      networks={single ? networks.slice(0, 1) : networks}
      network={network}
      onSelect={setNetwork}
      testIdPrefix="add-contact"
    />
  );
}

it('the contact E2E driver opens the picker, changes network and verifies the closed summary', async () => {
  render(<ContactNetworkFixture />);
  await selectContactNetwork(contactPage, { id: 'arbitrum', name: 'Arbitrum' }, 1000);
  expect(screen.getByTestId('add-contact-network-picker')).toHaveTextContent('Arbitrum');
  expect(screen.getByRole('dialog', { name: 'selectNetwork' })).toHaveAttribute('data-state', 'closed');
});

it('the contact E2E driver verifies a static Miden network without opening a picker', async () => {
  render(<ContactNetworkFixture chain="miden" />);
  await selectContactNetwork(contactPage, { id: 'miden', name: 'miden' }, 1000);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('the contact E2E driver supports a single fixed EVM network', async () => {
  render(<ContactNetworkFixture single />);
  await selectContactNetwork(contactPage, { id: 'base', name: 'Base' }, 1000);
  expect(screen.queryByTestId('add-contact-network-picker')).not.toBeInTheDocument();
});

it('the contact E2E driver rejects a choice that closed the picker without changing the selection', async () => {
  render(
    <NetworkField chain="ethereum" networks={networks} network="base" onSelect={jest.fn()} testIdPrefix="add-contact" />
  );
  await expect(selectContactNetwork(contactPage, { id: 'arbitrum', name: 'Arbitrum' }, 1000)).rejects.toThrow(
    'Contact network selection stayed "Base", expected "Arbitrum".'
  );
});
