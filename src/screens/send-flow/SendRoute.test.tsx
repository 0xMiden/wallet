import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { SendRoute, SendRouteProps } from './SendRoute';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// `SendStepLayout` is the shared `FlowLayout`; stub it to a probe that surfaces
// the header title, the back handler and where children/footer land, mirroring
// the sibling `ReviewTransaction.test.tsx`'s `./SendStepLayout` stub.
jest.mock('./SendStepLayout', () => ({
  SendStepLayout: ({ title, onBack, children, footer }: any) => (
    <div data-testid="send-route-layout">
      <h1>{title}</h1>
      <button data-testid="send-route-back" onClick={onBack}>
        back
      </button>
      <div data-testid="send-route-body">{children}</div>
      <div data-testid="send-route-footer">{footer}</div>
    </div>
  )
}));

// `RouteOptions` renders the Fast/Slow route cards; stub it to a probe that
// echoes the props `SendRoute` wires through, including the accent it forces.
jest.mock('./Route', () => ({
  RouteOptions: (props: any) => (
    <div
      data-testid="route-options"
      data-route={props.route}
      data-accent={props.accent}
      data-fast-fee={String(props.fastFeeUsd)}
      data-fast-loading={String(props.fastQuoteLoading)}
    />
  )
}));

// Stubs the accent through to a `data-accent` attribute (the SendAmount.test.tsx pattern) so the
// Confirm CTA's flow colour is assertable without the real Button's cva class computation.
jest.mock('components/Button', () => ({
  ButtonVariant: { Primary: 'primary' },
  Button: ({ title, variant: _variant, accent, ...rest }: any) => (
    <button type="button" data-accent={accent} {...rest}>
      {title}
    </button>
  )
}));

function renderRoute(overrides: Partial<SendRouteProps> = {}) {
  const props: SendRouteProps = {
    route: 'epoch',
    onRouteChange: jest.fn(),
    fastQuoteLoading: false,
    onBack: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides
  };
  render(<SendRoute {...props} />);
  return props;
}

describe('SendRoute', () => {
  it('shows the route title and forwards the back action', () => {
    const props = renderRoute();

    expect(screen.getByText('route')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('send-route-back'));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('gives Confirm the send flow colour', () => {
    renderRoute();

    expect(screen.getByTestId('bridge-route-confirm')).toHaveAttribute('data-accent', 'send');
  });

  it('forces the send accent on the route options regardless of the route, and wires Confirm', () => {
    const props = renderRoute({ route: 'agglayer' });

    const options = screen.getByTestId('route-options');
    expect(options).toHaveAttribute('data-accent', 'send');
    expect(options).toHaveAttribute('data-route', 'agglayer');

    fireEvent.click(screen.getByTestId('bridge-route-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });
});
