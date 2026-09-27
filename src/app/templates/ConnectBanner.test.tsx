import React from 'react';

import { render, screen, within } from '@testing-library/react';

import { DappMetadata } from 'lib/miden/types';

import ConnectBanner from './ConnectBanner';

// `Logo` pulls in png / `svg?url` asset imports (and react-i18next); stub it to
// a marker element that echoes the forwarded `style`/`className` so ConnectBanner's
// own JSX is what's under test. Mirrors the pattern in About.test.tsx.
jest.mock('app/atoms/Logo', () => ({
  __esModule: true,
  default: ({ style, className }: { style?: React.CSSProperties; className?: string }) => (
    <div data-testid="logo" data-style={JSON.stringify(style ?? {})} className={className} />
  )
}));

// The v2 icon barrel pulls in every SVG (and chain constants); stub `Icon` to a
// marker that records the props ConnectBanner passes, and expose the one
// `IconName` member the banner references. Mirrors PrivateDataPermissionBanner.test.tsx.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, fill, size }: { name: string; fill?: string; size?: string }) => (
    <span data-testid="icon" data-name={name} data-fill={fill} data-size={size} />
  ),
  IconName: { Globe: 'Globe' }
}));

// `appMeta` is declared on the props but never read by the component; a minimal
// cast keeps the test hermetic without pulling in the full DappMetadata shape.
const appMeta = { name: 'Test dApp' } as unknown as DappMetadata;

describe('ConnectBanner', () => {
  it('keeps a long origin whole on the connect prompt, with its registrable domain never truncated', () => {
    const origin = 'https://login.secure.account-verify.wallet.example.co.uk';
    render(<ConnectBanner type="connect" origin={origin} appMeta={appMeta} />);

    const shown = screen.getByTestId('connect-origin');
    expect(shown.textContent).toBe(origin);
    const domain = within(shown).getByTestId('dapp-origin-domain');
    expect(domain).toHaveTextContent(/^example\.co\.uk$/);
    expect(domain).not.toHaveClass('truncate');
    expect(within(shown).getByTestId('dapp-origin-lead')).toHaveClass('truncate');
  });

  it('renders the Logo with the forwarded height/margin/filter style', () => {
    render(<ConnectBanner type="connect" origin="https://example.com" appMeta={appMeta} />);

    const logo = screen.getByTestId('logo');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveClass('mb-1');
    expect(JSON.parse(logo.getAttribute('data-style')!)).toEqual({ height: 32, margin: 'auto', filter: '' });
  });

  it('renders the Globe icon with the expected fill and size props', () => {
    render(<ConnectBanner type="connect" origin="https://example.com" appMeta={appMeta} />);

    const icon = screen.getByTestId('icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-name', 'Globe');
    expect(icon).toHaveAttribute('data-fill', 'currentColor');
    expect(icon).toHaveAttribute('data-size', 'lg');
  });

  it('renders exactly one Logo and one Icon (the two connection endpoints)', () => {
    render(<ConnectBanner type="connect" origin="https://example.com" appMeta={appMeta} />);

    expect(screen.getAllByTestId('logo')).toHaveLength(1);
    expect(screen.getAllByTestId('icon')).toHaveLength(1);
  });

  it('renders an empty origin without crashing', () => {
    render(<ConnectBanner type="connect" origin="" appMeta={appMeta} />);

    expect(screen.getByTestId('connect-origin')).toHaveTextContent('');
    expect(screen.queryByTestId('dapp-origin-domain')).not.toBeInTheDocument();
  });

  it('reflects a different origin value, centred', () => {
    render(<ConnectBanner type="connect" origin="https://app.miden.io" appMeta={appMeta} />);

    const shown = screen.getByTestId('connect-origin');
    expect(shown.textContent).toBe('https://app.miden.io');
    expect(shown).toHaveClass('justify-center');
  });
});
