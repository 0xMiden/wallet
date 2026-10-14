import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { DetailCard, DetailDisclosure, DetailRow } from './DetailCard';

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));
// The disclosure's rows slide open on the `reveal` preset; the test reads the DOM, not the motion.
jest.mock('framer-motion', () => {
  const React = jest.requireActual('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: React.forwardRef(
        ({ initial: _i, animate: _a, exit: _e, transition: _t, ...props }: any, ref: React.Ref<HTMLDivElement>) => (
          <div ref={ref} {...props} />
        )
      )
    },
    useReducedMotion: () => false
  };
});

describe('DetailCard', () => {
  it('renders a fill card with 16px radius and hairline dividers between rows', () => {
    const { container } = render(
      <DetailCard>
        <DetailRow label="A">1</DetailRow>
        <DetailRow label="B">2</DetailRow>
      </DetailCard>
    );

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass('bg-fill', 'rounded-2xl', 'divide-y', 'divide-hairline');
  });

  it('forwards a caller className for margin/layout', () => {
    const { container } = render(<DetailCard className="mt-6">child</DetailCard>);
    expect(container.firstChild as HTMLElement).toHaveClass('mt-6');
  });

  it('sets a heading-face card in Nunito with semibold row labels', () => {
    const { container } = render(
      <DetailCard face="heading">
        <DetailRow label="Rate">1 ETH</DetailRow>
      </DetailCard>
    );

    expect(screen.getByText('Rate')).toHaveClass('text-body-sm', 'font-semibold');
    expect(container.firstChild as HTMLElement).toHaveClass('face-heading');
  });

  it('keeps the default card in the sans face with regular labels', () => {
    const { container } = render(
      <DetailCard>
        <DetailRow label="Rate">1 ETH</DetailRow>
      </DetailCard>
    );

    expect(screen.getByText('Rate')).not.toHaveClass('font-semibold');
    expect(container.firstChild as HTMLElement).not.toHaveClass('face-heading');
  });
});

describe('DetailRow', () => {
  it('renders the muted label and the ink value', () => {
    render(<DetailRow label="Network">Miden</DetailRow>);

    const label = screen.getByText('Network');
    // Inter, not the ancestor's Nunito: `DetailSection` (history) wraps its
    // cards in `font-heading`, and the label must stay Inter under it.
    expect(label).toHaveClass('text-body-sm', 'text-muted');

    const value = screen.getByText('Miden');
    expect(value).toHaveClass('text-value', 'text-ink');
  });

  it('does not break an unstacked value, which is always short', () => {
    render(<DetailRow label="Network">Miden</DetailRow>);
    expect(screen.getByText('Miden')).not.toHaveClass('break-all');
  });

  it('breaks a stacked value, for a full address that must wrap instead of overflow', () => {
    render(
      <DetailRow label="To" stacked>
        0xabc...def
      </DetailRow>
    );
    expect(screen.getByText('0xabc...def')).toHaveClass('break-all');
  });

  it('lays the value out beside the label by default, right-aligned', () => {
    const { container } = render(<DetailRow label="Network">Miden</DetailRow>);
    const row = container.firstChild as HTMLElement;
    expect(row).toHaveClass('items-start');
    expect(row).not.toHaveClass('flex-col');
  });

  it('stacks the value under the label when stacked is set, for a full address', () => {
    const { container } = render(
      <DetailRow label="To" stacked>
        0xabc...def
      </DetailRow>
    );
    const row = container.firstChild as HTMLElement;
    expect(row).toHaveClass('flex-col');
    expect(screen.getByText('0xabc...def')).toBeInTheDocument();
  });

  it('renders a sub line under the value when provided', () => {
    render(
      <DetailRow label="Network fee" sub="Estimated, reserved from Available">
        0.001 MDN
      </DetailRow>
    );
    expect(screen.getByText('Estimated, reserved from Available')).toHaveClass('text-muted');
  });

  it('renders an info hint beside the label, inside the label line', () => {
    render(
      <DetailRow label="Rate" info={<button data-testid="rate-info">i</button>}>
        1 ETH
      </DetailRow>
    );
    const label = screen.getByText('Rate');
    expect(label).toContainElement(screen.getByTestId('rate-info'));
  });

  it('renders no hint when none is provided', () => {
    render(<DetailRow label="Rate">1 ETH</DetailRow>);
    expect(screen.getByText('Rate').children).toHaveLength(0);
  });

  it('renders no action when none is provided', () => {
    render(<DetailRow label="Network">Miden</DetailRow>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the action as a small selected pill that fires its handler with a haptic', () => {
    const onClick = jest.fn();
    render(
      <DetailRow
        label="Expires"
        action={{ label: 'Edit', onClick, 'aria-haspopup': 'dialog', 'data-testid': 'detail-edit' }}
      >
        In 2 days
      </DetailRow>
    );

    const action = screen.getByRole('button', { name: 'Edit' });
    // `text-accent-primary` is 2.64:1 on `fill`, under AA; the selected pill's
    // `accent-tint-ink` on its own tint clears 4.5:1.
    expect(action).toHaveClass('h-6', 'rounded-full', 'bg-accent-tint', 'text-accent-tint-ink');
    expect(action).not.toHaveClass('text-accent-primary');
    expect(action).toHaveAttribute('data-testid', 'detail-edit');
    expect(action).toHaveAttribute('aria-haspopup', 'dialog');

    fireEvent.click(action);
    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards data-testid to the row root', () => {
    render(
      <DetailRow label="Address" data-testid="detail-address">
        0xabc
      </DetailRow>
    );
    expect(screen.getByTestId('detail-address')).toBeInTheDocument();
  });

  it('forwards a caller className to the row root for layout', () => {
    const { container } = render(
      <DetailRow label="Address" className="mt-2">
        0xabc
      </DetailRow>
    );
    expect(container.firstChild).toHaveClass('mt-2');
  });
});

describe('DetailRow onClick', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the whole row as a button with a trailing chevron and fires its handler with a haptic', () => {
    const onClick = jest.fn();
    render(
      <DetailRow label="Transfer type" onClick={onClick} data-testid="row">
        Private
      </DetailRow>
    );
    const row = screen.getByTestId('row');
    expect(row.tagName).toBe('BUTTON');
    expect(row).toHaveClass('w-full', 'text-left');
    expect(row.querySelector('svg')).not.toBeNull();

    fireEvent.click(row);
    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('declares the sheet the row opens with aria-haspopup', () => {
    render(
      <DetailRow label="Transfer type" onClick={jest.fn()} aria-haspopup="dialog" data-testid="row">
        Private
      </DetailRow>
    );
    expect(screen.getByTestId('row')).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('draws no chevron on a plain row', () => {
    render(
      <DetailRow label="Network" data-testid="row">
        Miden
      </DetailRow>
    );
    expect(screen.getByTestId('row').tagName).toBe('DIV');
    expect(screen.getByTestId('row').querySelector('svg')).toBeNull();
  });
});

describe('DetailDisclosure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const Harness: React.FC<{ initialOpen?: boolean; emphasis?: boolean }> = ({
    initialOpen = false,
    emphasis = false
  }) => {
    const [open, setOpen] = React.useState(initialOpen);
    return (
      <DetailCard>
        <DetailDisclosure
          title="Advanced options"
          summary="Private · In 7 days"
          summaryEmphasis={emphasis}
          open={open}
          onOpenChange={setOpen}
          data-testid="advanced"
        >
          <DetailRow label="Transfer type">Private</DetailRow>
        </DetailDisclosure>
      </DetailCard>
    );
  };

  it('starts closed with the summary visible and the rows hidden, and exposes the state to assistive tech', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: /Advanced options/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls');
    expect(screen.getByTestId('advanced-summary')).toHaveTextContent('Private · In 7 days');
    expect(screen.getByTestId('advanced-summary')).toHaveClass('text-muted');
    expect(screen.queryByText('Transfer type')).not.toBeInTheDocument();
  });

  it('opens on tap with a haptic, hiding the summary and revealing the rows under a hairline', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: /Advanced options/ });
    fireEvent.click(toggle);

    expect(hapticLight).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('advanced-summary')).not.toBeInTheDocument();
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(region).not.toBeNull();
    expect(region).toContainElement(screen.getByText('Transfer type'));
    expect(region?.firstElementChild).toHaveClass('divide-y', 'divide-hairline', 'border-t', 'border-hairline');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('advanced-summary')).toBeInTheDocument();
  });

  it("keeps a heading-face card's semibold labels on the rows it reveals", () => {
    render(
      <DetailCard face="heading">
        <DetailDisclosure title="Advanced options" open onOpenChange={jest.fn()}>
          <DetailRow label="Transfer type" onClick={jest.fn()}>
            Private
          </DetailRow>
          <DetailRow label="Expires">In 7 days</DetailRow>
        </DetailDisclosure>
      </DetailCard>
    );
    expect(screen.getByText('Transfer type')).toHaveClass('font-semibold');
    expect(screen.getByText('Expires')).toHaveClass('font-semibold');
  });

  it('draws an emphasised summary in accent-tint-ink, the one accent that reads on fill', () => {
    render(<Harness emphasis />);
    expect(screen.getByTestId('advanced-summary')).toHaveClass('text-accent-tint-ink');
    expect(screen.getByTestId('advanced-summary')).not.toHaveClass('text-muted');
  });
});
