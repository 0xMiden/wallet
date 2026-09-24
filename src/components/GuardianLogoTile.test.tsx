import React from 'react';

import { render, screen } from '@testing-library/react';

import GuardianLogoTileDefault, { GuardianLogoTile } from './GuardianLogoTile';

describe('GuardianLogoTile', () => {
  it('exports the component as the default export', () => {
    expect(GuardianLogoTileDefault).toBe(GuardianLogoTile);
  });

  it('draws a provider mark on the 48px brand tile, decorative', () => {
    render(<GuardianLogoTile guardianId="open-zeppelin" />);
    const tile = screen.getByTestId('guardian-logo-tile');
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    expect(tile).toHaveClass('size-12', 'rounded-xl', 'bg-pure-white', 'dark:bg-grey-800', 'border-hairline');
    expect(screen.getByTestId('guardian-operator-logo')).toHaveClass('h-full', 'text-ink');
  });

  it('recolours a grey mark to the theme ink', () => {
    render(<GuardianLogoTile guardianId="gateway" />);
    expect(screen.getByTestId('guardian-operator-logo')).toHaveClass('[&_path]:fill-ink');
  });

  it('scales the wordmark into the tile for a provider with no standalone mark', () => {
    render(<GuardianLogoTile guardianId="lambda-class" />);
    expect(screen.getByTestId('guardian-operator-logo')).toHaveClass('w-full', 'h-auto');
  });

  it('falls back to the generic avatar for an unknown or absent provider', () => {
    const { rerender } = render(<GuardianLogoTile guardianId="mystery" />);
    expect(screen.getByTestId('guardian-avatar')).toBeInTheDocument();
    rerender(<GuardianLogoTile />);
    expect(screen.getByTestId('guardian-avatar')).toBeInTheDocument();
  });

  it('draws the 88px circle at hero size', () => {
    render(<GuardianLogoTile guardianId="kodax" size="hero" />);
    expect(screen.getByTestId('guardian-logo-tile')).toHaveClass('size-22', 'rounded-full');
  });
});
