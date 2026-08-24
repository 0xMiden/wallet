import React from 'react';

import { render, screen } from '@testing-library/react';

import { ITransactionStatus } from 'lib/miden/db/types';

import { ExternalLinkValue, StatusPill, DetailCard, DetailRow } from './DetailCard';

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

describe('DetailCard and DetailRow', () => {
  it('renders a compact pill title without a bordered card shell', () => {
    const { container } = render(
      <DetailCard title="Transfer Details">
        <span>content</span>
      </DetailCard>
    );

    const section = container.querySelector('section')!;
    expect(section).toHaveClass('font-heading');
    expect(section).not.toHaveClass('border', 'rounded-10', 'bg-white');
    expect(screen.getByText('Transfer Details')).toHaveClass('inline-flex', 'rounded-full', 'bg-gray-50');
    expect(screen.getByText('content').parentElement).toHaveClass('mt-2');
  });

  it('renders simple key/value rows with only an inter-row rule', () => {
    const { container } = render(
      <>
        <DetailRow label="Date" value="20 Jan 2026" />
        <DetailRow label="From" isLast>
          <span>Account 1</span>
        </DetailRow>
      </>
    );

    const rows = Array.from(container.children) as HTMLElement[];
    expect(rows[0]).toHaveClass('border-b', 'border-border-light', 'px-2', 'py-5');
    expect(rows[1]).not.toHaveClass('border-b');
    expect(screen.getByText('Date')).toHaveClass('font-semibold');
    expect(screen.getByText('20 Jan 2026')).toHaveClass('text-right');
    expect(screen.getByText('Account 1').parentElement).toHaveClass('justify-end', 'text-right');
  });

  it('supports the existing icon and badge row variants', () => {
    render(<DetailRow label="Status" icon={<span data-testid="row-icon" />} badge="Active" isLast />);

    expect(screen.getByTestId('row-icon')).toBeInTheDocument();
    expect(screen.getByText('Active')).toHaveClass('rounded-full', 'bg-yellow-50');
  });
});

describe('ExternalLinkValue', () => {
  it('renders the display value alongside an external anchor and forwarded Icon props', () => {
    const { container } = render(
      <ExternalLinkValue
        displayValue={<span data-testid="disp">0xabc…def</span>}
        href="https://explorer.example/tx/1"
      />
    );

    // Wrapper carries the layout/typography classes.
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('flex', 'items-center', 'gap-1', 'text-sm', 'text-heading-gray', 'font-medium');

    // The provided ReactNode is rendered verbatim.
    expect(screen.getByTestId('disp')).toHaveTextContent('0xabc…def');

    // External anchor with the security attributes and target.
    const anchor = container.querySelector('a') as HTMLAnchorElement;
    expect(anchor).toHaveAttribute('href', 'https://explorer.example/tx/1');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noreferrer');

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
  const dot = (container: HTMLElement) => pill(container).querySelector('div') as HTMLElement;
  // The leading decoration is a <span> too — the aria-hidden wrapper, and inside
  // it the v2-icon mock — so the label is identified by NOT being hidden. That
  // doubles as the assertion that the glyph stays out of the accessibility tree:
  // it restates the label, and announcing both named the status twice.
  const label = (container: HTMLElement) =>
    pill(container).querySelector('span:not([aria-hidden]):not([data-testid="v2-icon"])') as HTMLElement;

  it('renders the completed variant as a solid green pill with dark ink and a matching checkmark', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} />);

    // Dark ink, not white: these fills are mid-tone, so white 12px text on them
    // sits near 2.4:1 — under AA. The icon inherits the same ink.
    expect(pill(container)).toHaveClass('flex', 'items-center', 'rounded-full', 'bg-tx-received', 'text-pure-black');

    const icon = pill(container).querySelector('[data-testid="v2-icon"]');
    expect(icon).toHaveAttribute('data-name', 'checkmark');
    expect(icon).toHaveAttribute('data-fill', 'currentColor');

    const text = label(container);
    expect(text).toHaveClass('font-semibold');
    expect(text).toHaveTextContent('t:confirmed');
  });

  it('reports an unsettled swap as pending even though its row is Completed', () => {
    // A swap row is Completed once the order note exists — the place-order
    // transaction confirmed, the swap itself has not. Reading "Confirmed" there
    // contradicts both the history list and the order status on the receipt.
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} swapSettlement="pending" />);

    expect(label(container)).toHaveTextContent('t:pending');
    expect(label(container)).not.toHaveTextContent('t:confirmed');
  });

  it('reports a reclaimed swap as reclaimed, and tones it like a cancellation', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} swapSettlement="reclaimed" />);

    expect(label(container)).toHaveTextContent('t:reclaimed');
    expect(pill(container)).toHaveClass('bg-gray-400', 'text-pure-white');
  });

  it('inks a cancellation for its own grey fill rather than inheriting the failure pill\u2019s', () => {
    // A user cancellation is recorded as a failure (`cancel.ts`), so it is BOTH
    // Failed and cancelled — the ink ternary has to branch on muted first or this
    // pill gets the failure pill's ink. grey #737373 is the one fill that wants
    // white (4.74:1; black is 4.43:1, under AA).
    const { container } = render(<StatusPill status={ITransactionStatus.Failed} isCancelled />);

    expect(label(container)).toHaveTextContent('t:cancelled');
    expect(pill(container)).toHaveClass('bg-gray-400', 'text-pure-white');
    expect(pill(container)).not.toHaveClass('text-pure-black');
    // ...and it wears the neutral dot rather than the failure ✕, which would name
    // a second outcome the label does not.
    expect(pill(container).querySelector('[data-testid="v2-icon"]')).toBeNull();
    expect(dot(container)).toHaveClass('bg-current');
  });

  it('lets failure outrank a reported settlement rather than labelling it in red', () => {
    // A failed swap never placed its order, so it has no settlement to report.
    // Taking the caller's word for one produced a pill reading "Pending" in
    // failure red — two different outcomes at once, with the actionable one
    // spelled only in colour.
    const { container } = render(<StatusPill status={ITransactionStatus.Failed} swapSettlement="pending" />);

    expect(label(container)).toHaveTextContent('t:failed');
    expect(pill(container)).toHaveClass('bg-status-negative');
  });

  it('renders the failed variant as a solid negative pill whose ink flips with the theme', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Failed} />);

    // status-negative is the one fill that flips with the theme (light #ff5500,
    // dark #c51a0a) and neither ink clears AA on both, so this is the one pill
    // that carries a dark: variant: 6.55:1 light, 5.96:1 dark.
    expect(pill(container)).toHaveClass('bg-status-negative', 'text-pure-black', 'dark:text-pure-white');

    const icon = pill(container).querySelector('[data-testid="v2-icon"]');
    expect(icon).toHaveAttribute('data-name', 'close');
    expect(icon).toHaveAttribute('data-fill', 'currentColor');

    expect(label(container)).toHaveTextContent('t:failed');
  });

  it('renders the in-progress (blue) fallback when status is undefined', () => {
    const { container } = render(<StatusPill />);

    expect(pill(container)).toHaveClass('bg-tx-sent', 'text-pure-black');
    // The dot inherits the pill's ink instead of hardcoding white.
    expect(dot(container)).toHaveClass('bg-current');

    expect(label(container)).toHaveTextContent('t:inProgress');
  });

  it('treats non-terminal statuses (Queued / GeneratingTransaction) as in-progress', () => {
    const { container: queued } = render(<StatusPill status={ITransactionStatus.Queued} />);
    expect(label(queued)).toHaveTextContent('t:inProgress');

    const { container: generating } = render(<StatusPill status={ITransactionStatus.GeneratingTransaction} />);
    expect(label(generating)).toHaveTextContent('t:inProgress');
  });
});
