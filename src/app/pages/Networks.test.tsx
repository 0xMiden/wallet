import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import NetworksSettings from './Networks';

// --- Mocks -----------------------------------------------------------------
//
// Networks.tsx is a thin settings screen: it maps over the static NETWORKS
// list, renders a CardItem per network, marks the active one with a checkmark
// and calls `setNetworkId` on click. We mock every leaf dependency so the test
// exercises *only* Networks.tsx's own branching (the active-vs-inactive
// checkmark ternary and the click handler) without pulling in the real Miden
// SDK, icon SVGs or haptics stack.

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
// only the two IconName members Networks.tsx references.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: {
    MidenLogoWhite: 'miden-logo-white',
    CheckboxCircleFill: 'checkbox-circle-fill'
  }
}));

// Stub CardItem to a button that surfaces the props Networks.tsx passes
// (title, iconLeft, iconRight, onClick) so we can assert the checkmark logic
// and the click wiring directly, without the real CardItem's haptics/clsx deps.
jest.mock('components/CardItem', () => ({
  CardItem: ({
    title,
    iconLeft,
    iconRight,
    onClick
  }: {
    title?: string;
    iconLeft?: React.ReactNode;
    iconRight?: React.ReactNode | string | null;
    onClick?: () => void;
  }) => (
    <button
      type="button"
      data-testid={`network-${title}`}
      data-icon-right={iconRight == null ? 'none' : String(iconRight)}
      onClick={onClick}
    >
      {iconLeft}
      <span>{title}</span>
    </button>
  )
}));

describe('NetworksSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNetwork = { id: 'testnet', name: 'Testnet' };
  });

  it('renders one CardItem per network with its name as the title', () => {
    render(<NetworksSettings />);

    expect(screen.getByTestId('network-Testnet')).toBeInTheDocument();
    expect(screen.getByTestId('network-Devnet')).toBeInTheDocument();
    expect(screen.getByTestId('network-Localnet')).toBeInTheDocument();
  });

  it('renders the Miden logo icon on the left of every network row', () => {
    render(<NetworksSettings />);

    const icons = screen.getAllByTestId('icon');
    // One left-hand logo per network in the list.
    expect(icons).toHaveLength(3);
    icons.forEach(icon => expect(icon).toHaveAttribute('data-name', 'miden-logo-white'));
  });

  it('marks only the active network with the checkbox-circle-fill icon', () => {
    render(<NetworksSettings />);

    // Active branch of the ternary: network.id === item.id.
    expect(screen.getByTestId('network-Testnet')).toHaveAttribute('data-icon-right', 'checkbox-circle-fill');
    // Inactive branch: falls through to null -> our stub renders 'none'.
    expect(screen.getByTestId('network-Devnet')).toHaveAttribute('data-icon-right', 'none');
    expect(screen.getByTestId('network-Localnet')).toHaveAttribute('data-icon-right', 'none');
  });

  it('calls setNetworkId with the clicked network id', () => {
    render(<NetworksSettings />);

    fireEvent.click(screen.getByTestId('network-Devnet'));

    expect(mockSetNetworkId).toHaveBeenCalledTimes(1);
    expect(mockSetNetworkId).toHaveBeenCalledWith('devnet');
  });

  it('lets every row be selected independently', () => {
    render(<NetworksSettings />);

    fireEvent.click(screen.getByTestId('network-Testnet'));
    fireEvent.click(screen.getByTestId('network-Localnet'));

    expect(mockSetNetworkId).toHaveBeenNthCalledWith(1, 'testnet');
    expect(mockSetNetworkId).toHaveBeenNthCalledWith(2, 'localnet');
  });

  it('moves the checkmark to whichever network is currently active', () => {
    const { rerender } = render(<NetworksSettings />);
    expect(screen.getByTestId('network-Testnet')).toHaveAttribute('data-icon-right', 'checkbox-circle-fill');

    // Flip the active network and re-render; the checkmark should follow.
    mockNetwork = { id: 'localnet', name: 'Localnet' };
    rerender(<NetworksSettings />);

    expect(screen.getByTestId('network-Testnet')).toHaveAttribute('data-icon-right', 'none');
    expect(screen.getByTestId('network-Localnet')).toHaveAttribute('data-icon-right', 'checkbox-circle-fill');
  });
});
