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
  IconName: { ArrowRightUp: 'arrow-right-up' },
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
    expect(screen.getByText('Transfer Details')).toHaveClass('inline-flex', 'rounded-full', 'bg-[#F1F1F1]');
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
    expect(screen.getByText('Active')).toHaveClass('rounded-full', 'bg-[#FFF3EB]');
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
  const label = (container: HTMLElement) => pill(container).querySelector('span') as HTMLElement;

  it('renders the completed (green) variant for status === Completed', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} />);

    expect(pill(container)).toHaveClass('flex', 'items-center', 'rounded-full', 'bg-green-600/20');
    expect(dot(container)).toHaveClass('bg-[#1A9C52]');
    expect(dot(container)).not.toHaveClass('bg-status-negative', 'bg-blue-500');

    const text = label(container);
    expect(text).toHaveClass('text-[#1A9C52]');
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

  it('reports a reclaimed swap as reclaimed, not confirmed', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Completed} swapSettlement="reclaimed" />);

    expect(label(container)).toHaveTextContent('t:reclaimed');
  });

  it('renders the failed (negative) variant for status === Failed', () => {
    const { container } = render(<StatusPill status={ITransactionStatus.Failed} />);

    expect(dot(container)).toHaveClass('bg-status-negative');
    expect(dot(container)).not.toHaveClass('bg-[#1A9C52]', 'bg-blue-500');

    const text = label(container);
    expect(text).toHaveClass('text-status-negative');
    expect(text).toHaveTextContent('t:failed');
  });

  it('renders the in-progress (blue) fallback when status is undefined', () => {
    const { container } = render(<StatusPill />);

    expect(dot(container)).toHaveClass('bg-blue-500');
    expect(dot(container)).not.toHaveClass('bg-[#1A9C52]', 'bg-status-negative');

    const text = label(container);
    expect(text).toHaveClass('text-blue-500');
    expect(text).toHaveTextContent('t:inProgress');
  });

  it('treats non-terminal statuses (Queued / GeneratingTransaction) as in-progress', () => {
    const { container: queued } = render(<StatusPill status={ITransactionStatus.Queued} />);
    expect(queued.querySelector('span')).toHaveTextContent('t:inProgress');

    const { container: generating } = render(<StatusPill status={ITransactionStatus.GeneratingTransaction} />);
    expect(generating.querySelector('span')).toHaveTextContent('t:inProgress');
  });
});
