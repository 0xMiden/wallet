import React from 'react';

import { render, screen } from '@testing-library/react';

import { avatarLabel, ContactAvatar, tintForAddress } from './ContactAvatar';

jest.mock('components/NetworkChip', () => ({
  NetworkLogo: ({ kind }: { kind: string }) => <svg data-testid={`logo-${kind}`} />
}));

describe('avatarLabel', () => {
  it('uses up to two initials from the name', () => {
    expect(avatarLabel('mtst1abc', 'alice')).toBe('A');
    expect(avatarLabel('mtst1abc', 'Alice  Smith Jones')).toBe('AS');
  });

  it('falls back to the first character after the address prefix', () => {
    expect(avatarLabel('mtst1qrzxy')).toBe('Q');
    expect(avatarLabel('mm1pqrs')).toBe('P');
    expect(avatarLabel('0x3650dB63')).toBe('3');
    expect(avatarLabel('mtst1qrzxy', '   ')).toBe('Q');
  });
});

describe('tintForAddress', () => {
  it('is stable per address and ignores case and whitespace', () => {
    expect(tintForAddress('0xAbC')).toBe(tintForAddress(' 0xabc '));
  });

  it('spreads different addresses across the palette', () => {
    const tints = new Set(['mtst1aaa', 'mtst1bbb', 'mtst1ccc', 'mtst1ddd', 'mtst1eee', 'mtst1fff'].map(tintForAddress));
    expect(tints.size).toBeGreaterThan(1);
  });
});

describe('ContactAvatar', () => {
  it('shows the initials on the contact color, with an optional network badge', () => {
    render(<ContactAvatar address="0xabc" name="Bob Lee" network="ethereum" />);

    const avatar = screen.getByTestId('contact-avatar');
    expect(avatar).toHaveAttribute('data-network', 'ethereum');
    expect(avatar).toHaveTextContent('BL');
    expect(screen.getByTestId('logo-ethereum')).toBeInTheDocument();
  });

  it('omits the badge without a network', () => {
    render(<ContactAvatar address="mtst1qrz" />);

    expect(screen.queryByTestId('logo-miden')).not.toBeInTheDocument();
    expect(screen.getByTestId('contact-avatar')).toHaveTextContent('Q');
  });
});
