import React from 'react';

import { render, screen } from '@testing-library/react';

import { ITransactionStatus } from 'lib/miden/db/types';

import { ExternalLinkValue, StatusPill } from './TransactionStatus';

// Pull the mocked enum back in with the same shape the component sees.

// `react-i18next` pulls in the full i18n runtime; stub `useTranslation` so
// `t(key)` echoes `t:<key>` back and we can assert which label branch rendered.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` })
}));

// `app/icons/v2` is the real barrel that switches an `IconName` onto ~100 SVG
// imports and drags in the Miden chain-constants graph. Replace it with a
// marker `Icon` (surfacing the `name`/`size`/`fill` props ExternalLinkValue
// forwards) plus a minimal `IconName` enum exposing the single member used.
jest.mock('app/icons/v2', () => ({
  __esModule: true,
  IconName: { ArrowRightUp: 'arrow-right-up', Checkmark: 'checkmark', Close: 'close' },
  Icon: ({ name, size, fill }: { name: string; size?: string; fill?: string }) => (
    <span data-testid="v2-icon" data-name={name} data-size={size} data-fill={fill} />
  )
}));

// `lib/miden/db/types` transitively imports `lib/miden/types` (the SDK/native
// asset stack). The component only reads the `ITransactionStatus` numeric enum,
// so replace the module with just that enum, preserving the real ordinals
// (Queued=0, GeneratingTransaction=1, Completed=2, Failed=3).
jest.mock('lib/miden/db/types', () => ({
  __esModule: true,
  ITransactionStatus: {
    Queued: 0,
    GeneratingTransaction: 1,
    Completed: 2,
    Failed: 3
  }
}));

// The mock above hand-copies the ordinals, so on its own this whole suite would
// keep passing if the real enum were renumbered — every status assertion below is
// really an assertion about the copy. Pin the copy to the original.
it('mocks ITransactionStatus with the real ordinals', () => {
  const actual = jest.requireActual<typeof import('lib/miden/db/types')>('lib/miden/db/types');

  expect(actual.ITransactionStatus.Queued).toBe(0);
  expect(actual.ITransactionStatus.GeneratingTransaction).toBe(1);
  expect(actual.ITransactionStatus.Completed).toBe(2);
  expect(actual.ITransactionStatus.Failed).toBe(3);
});

describe('ExternalLinkValue', () => {
  it('renders the display value alongside an external anchor and forwarded Icon props', () => {
    const { container } = render(
      <ExternalLinkValue
        displayValue={<span data-testid="disp">0xabc…def</span>}
        href="https://explorer.example/tx/1"
      />
    );

    // Wrapper carries the layout/typography classes. `min-w-0` lets a Pill-with-copy displayValue
    // (whose own `truncate` needs a bounded width) actually shrink within a narrow row instead of
    // forcing it wider; `max-w-full` caps the row at its parent's width so a long value (e.g. a
    // "You (account name)" chip) truncates against that cap instead of overflowing it.
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass(
      'flex',
      'min-w-0',
      'max-w-full',
      'items-center',
      'gap-1',
      'text-sm',
      'text-ink',
      'font-medium'
    );

    // The provided ReactNode is rendered verbatim.
    expect(screen.getByTestId('disp')).toHaveTextContent('0xabc…def');

    // External anchor with the security attributes and target, and `shrink-0` so the min-w-0 row
    // squeezes the displayValue rather than the link's own arrow glyph.
    const anchor = container.querySelector('a') as HTMLAnchorElement;
    expect(anchor).toHaveAttribute('href', 'https://explorer.example/tx/1');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noreferrer');
    expect(anchor).toHaveClass('shrink-0');

    // Icon forwarded with the ArrowRightUp name + xs size + gray fill.
    const icon = screen.getByTestId('v2-icon');
    expect(anchor).toContainElement(icon);
    expect(icon).toHaveAttribute('data-name', 'arrow-right-up');
    expect(icon).toHaveAttribute('data-size', 'xs');
    expect(icon).toHaveAttribute('data-fill', '#9E9E9E');
  });

  it('renders a plain-string display value', () => {
    render(<ExternalLinkValue displayValue="raw text" href="https://x.test" />);
    expect(screen.getByText('raw text')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://x.test');
  });
});

describe('StatusPill', () => {
  const pill = (container: HTMLElement) => container.firstChild as HTMLElement;
  // The dot is the `aria-hidden` leading span the Pill component renders for
  // `dot`; decorative only, since the label already names the status.
  const dot = (container: HTMLElement) => pill(container).querySelector('[aria-hidden="true"]') as HTMLElement;

  it('renders the completed variant as a positive-toned pill with a dot', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} />);

    expect(pill(container)).toHaveClass('text-positive-ink');
    expect(dot(container)).toHaveClass('bg-current');
    expect(pill(container)).toHaveTextContent('t:confirmed');
  });

  it('reports an unsettled swap as pending even though its row is Completed', () => {
    // A swap row is Completed once the order note exists -- the place-order
    // transaction confirmed, the swap itself has not. Reading "Confirmed" there
    // contradicts both the history list and the order status on the receipt.
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} swapSettlement="pending" />);

    expect(pill(container)).toHaveTextContent('t:pending');
    expect(pill(container)).not.toHaveTextContent('t:confirmed');
  });

  it('reports a reclaimed swap as reclaimed, and tones it like a cancellation', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} swapSettlement="reclaimed" />);

    expect(pill(container)).toHaveTextContent('t:reclaimed');
    expect(pill(container)).toHaveClass('bg-fill', 'text-ink');
  });

  it("inks a cancellation for the neutral pill rather than inheriting the failure pill's tone", () => {
    // A user cancellation is recorded as a failure (`cancel.ts`), so it is BOTH
    // Failed and cancelled -- the tone ternary has to branch on muted first or
    // this pill gets the failure pill's color.
    const { container } = render(<StatusPill status={ITransactionStatus.Failed} isCancelled />);

    expect(pill(container)).toHaveTextContent('t:cancelled');
    expect(pill(container)).toHaveClass('bg-fill', 'text-ink');
    expect(pill(container)).not.toHaveClass('text-negative-ink');
    expect(dot(container)).toHaveClass('bg-current');
  });

  it('lets failure outrank a reported settlement rather than labelling it in red', () => {
    // A failed swap never placed its order, so it has no settlement to report.
    // Taking the caller's word for one produced a pill reading "Pending" in
    // failure red -- two different outcomes at once, with the actionable one
    // spelled only in colour.
    const { container } = render(<StatusPill status={ITransactionStatus.Failed} swapSettlement="pending" />);

    expect(pill(container)).toHaveTextContent('t:failed');
    expect(pill(container)).toHaveClass('text-negative-ink');
  });

  it('renders the failed variant as a negative-toned pill with a dot', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Failed} />);

    expect(pill(container)).toHaveClass('text-negative-ink');
    expect(dot(container)).toHaveClass('bg-current');
    expect(pill(container)).toHaveTextContent('t:failed');
  });

  it('renders the in-progress (warning) fallback when status is undefined', () => {
    const { container } = render(<StatusPill />);

    expect(pill(container)).toHaveClass('text-pending-ink');
    // The dot inherits the pill's ink instead of hardcoding a fixed color.
    expect(dot(container)).toHaveClass('bg-current');

    expect(pill(container)).toHaveTextContent('t:inProgress');
  });

  it('treats non-terminal statuses (Queued / GeneratingTransaction) as in-progress', () => {
    const { container: queued } = render(<StatusPill status={ITransactionStatus.Queued} />);
    expect(pill(queued)).toHaveTextContent('t:inProgress');

    const { container: generating } = render(<StatusPill status={ITransactionStatus.GeneratingTransaction} />);
    expect(pill(generating)).toHaveTextContent('t:inProgress');
  });
});
