import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import NetworksSettings from './Networks';

// --- Mocks -----------------------------------------------------------------
//
// Networks.tsx is a thin settings screen: it maps over the static NETWORKS
// list, renders a ListRow per network in one ListGroup, marks the active one
// with a check and calls `setNetworkId` on click. We mock every leaf dependency so the test
// exercises *only* Networks.tsx's own branching (the active-vs-inactive
// checkmark ternary and the click handler) without pulling in the real Miden
// SDK, icon SVGs or haptics stack. ListRow itself is real.

// Deterministic network list so the active/inactive branches are both hit:
// `testnet` is the selected network (checkmark), the other two are not (null).
jest.mock('lib/miden/networks', () => ({
  NETWORKS: [
    { id: 'testnet', name: 'Testnet' },
    { id: 'devnet', name: 'Devnet' },
    { id: 'localnet', name: 'Localnet' }
  ]
}));

// Controllable network + spy for the setter. `mockNetwork` is a `let` so a test
// can flip the active network and re-render to prove the checkmark follows it.
const mockSetNetworkId = jest.fn();
let mockNetwork: { id: string; name: string } = { id: 'testnet', name: 'Testnet' };
jest.mock('lib/miden/front', () => ({
  useSetNetworkId: () => mockSetNetworkId,
  useNetwork: () => mockNetwork
}));

// `app/icons/v2` resolves real SVGs; stub Icon to a marker element and expose
// only the IconName member Networks.tsx references.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: { MidenLogo: 'miden-logo' }
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

const checked = (id: string) => screen.getByTestId(`networks-${id}`).getAttribute('aria-pressed');

describe('NetworksSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNetwork = { id: 'testnet', name: 'Testnet' };
  });

  it('renders one row per network in a single group, titled with its name', () => {
    render(<NetworksSettings />);

    const testnet = screen.getByTestId('networks-testnet');
    expect(testnet).toHaveTextContent('Testnet');
    expect(screen.getByTestId('networks-devnet')).toHaveTextContent('Devnet');
    expect(screen.getByTestId('networks-localnet')).toHaveTextContent('Localnet');
    expect(testnet.parentElement).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
    expect(testnet.parentElement).not.toHaveClass('bg-fill');
    expect(screen.getByTestId('networks-localnet').parentElement).toBe(testnet.parentElement);
  });

  it('renders through SubPageLayout, the group straight in its body', () => {
    render(<NetworksSettings />);

    const body = screen.getByTestId('networks-settings').querySelector('[data-slot="body"]')!;
    expect(body).toHaveClass('px-4', 'overflow-y-auto');
    expect(body.firstElementChild).toHaveClass('[&>*]:px-0', '[&>*]:before:left-0');
  });

  it('renders the Miden logo on the left of every network row', () => {
    render(<NetworksSettings />);

    const icons = screen.getAllByTestId('icon');
    expect(icons).toHaveLength(3);
    icons.forEach(icon => expect(icon).toHaveAttribute('data-name', 'miden-logo'));
  });

  it('checks only the active network', () => {
    render(<NetworksSettings />);

    expect(checked('testnet')).toBe('true');
    expect(checked('devnet')).toBe('false');
    expect(checked('localnet')).toBe('false');
    expect(screen.getByTestId('networks-testnet').querySelector('[data-slot="check"]')).not.toBeNull();
    expect(screen.getByTestId('networks-devnet').querySelector('[data-slot="check"]')).toBeNull();
  });

  it('calls setNetworkId with the clicked network id', () => {
    render(<NetworksSettings />);

    fireEvent.click(screen.getByTestId('networks-devnet'));

    expect(mockSetNetworkId).toHaveBeenCalledTimes(1);
    expect(mockSetNetworkId).toHaveBeenCalledWith('devnet');
  });

  it('lets every row be selected independently', () => {
    render(<NetworksSettings />);

    fireEvent.click(screen.getByTestId('networks-testnet'));
    fireEvent.click(screen.getByTestId('networks-localnet'));

    expect(mockSetNetworkId).toHaveBeenNthCalledWith(1, 'testnet');
    expect(mockSetNetworkId).toHaveBeenNthCalledWith(2, 'localnet');
  });

  it('moves the check to whichever network is currently active', () => {
    const { rerender } = render(<NetworksSettings />);
    expect(checked('testnet')).toBe('true');

    mockNetwork = { id: 'localnet', name: 'Localnet' };
    rerender(<NetworksSettings />);

    expect(checked('testnet')).toBe('false');
    expect(checked('localnet')).toBe('true');
  });
});
