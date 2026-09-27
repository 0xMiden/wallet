import React from 'react';

import { render, screen, within } from '@testing-library/react';

import { DappOrigin } from './DappOrigin';

describe('DappOrigin', () => {
  it('elides only the lead: the registrable domain never truncates and wraps when it alone is too wide', () => {
    render(<DappOrigin origin="https://login.wallet.example.co.uk" data-testid="origin" />);

    const root = screen.getByTestId('origin');
    expect(root.textContent).toBe('https://login.wallet.example.co.uk');
    expect(root).toHaveAttribute('title', 'https://login.wallet.example.co.uk');

    const lead = within(root).getByTestId('dapp-origin-lead');
    expect(lead).toHaveTextContent(/^https:\/\/login\.wallet\.$/);
    expect(lead).toHaveClass('min-w-0', 'truncate');

    const domain = within(root).getByTestId('dapp-origin-domain');
    expect(domain).toHaveTextContent(/^example\.co\.uk$/);
    expect(domain).toHaveClass('shrink-0', 'max-w-full', 'break-all');
    expect(domain).not.toHaveClass('truncate');
  });

  it('renders no lead span when nothing precedes the kept part', () => {
    render(<DappOrigin origin="app.miden.io" data-testid="origin" />);

    expect(within(screen.getByTestId('origin')).queryByTestId('dapp-origin-lead')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('origin')).getByTestId('dapp-origin-domain')).toHaveTextContent(
      /^app\.miden\.io$/
    );
  });

  it('passes its className to the root', () => {
    render(<DappOrigin origin="https://example.com" className="justify-center font-semibold" data-testid="origin" />);

    expect(screen.getByTestId('origin')).toHaveClass('flex', 'min-w-0', 'justify-center', 'font-semibold');
  });

  it('gives assistive tech the whole origin once, and hides the visual split from it', () => {
    const origin = 'https://login.wallet.example.co.uk';
    render(<DappOrigin origin={origin} data-testid="origin" />);

    expect(screen.getByText(origin, { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByTestId('origin')).toHaveAttribute('aria-hidden', 'true');
  });
});
