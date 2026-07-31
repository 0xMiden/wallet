import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { BalanceCard } from './BalanceCard';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <span data-testid="icon" data-name={name} />,
  IconName: {
    More: 'More',
    MidenLogo: 'MidenLogo'
  }
}));

jest.mock('app/atoms/CopyButton', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticLight: jest.fn()
}));

jest.mock('lib/settings/card-color', () => ({
  useCardColor: () => 'slate'
}));

/* jsdom has no layout engine, so the fit-to-width hook's measurements are
 * simulated: the amount span reports AMOUNT_SCROLL_WIDTH px at a 56px font,
 * the row reports ROW_CLIENT_WIDTH px, and the currency suffix 40px. */
const ROW_CLIENT_WIDTH = 400;
const SUFFIX_OFFSET_WIDTH = 40;
const COLUMN_GAP = 2;

let amountScrollWidth = 0;

const isAmountSpan = (el: HTMLElement) => el.tagName === 'SPAN' && el.style.fontSize !== '';
const isSuffixSpan = (el: HTMLElement) => el.tagName === 'SPAN' && el.className.includes('shrink-0');

describe('BalanceCard amount fit-to-width', () => {
  let scrollWidthSpy: jest.SpyInstance;
  let clientWidthSpy: jest.SpyInstance;
  let offsetWidthSpy: jest.SpyInstance;
  let computedStyleSpy: jest.SpyInstance;

  beforeEach(() => {
    scrollWidthSpy = jest.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return isAmountSpan(this) ? amountScrollWidth : 0;
    });
    clientWidthSpy = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.tagName === 'DIV' ? ROW_CLIENT_WIDTH : 0;
    });
    offsetWidthSpy = jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return isSuffixSpan(this) ? SUFFIX_OFFSET_WIDTH : 0;
    });
    computedStyleSpy = jest.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const style = document.createElement('span').style;
      style.fontSize = el === document.documentElement ? '16px' : '56px';
      style.columnGap = `${COLUMN_GAP}px`;
      return style;
    });
  });

  afterEach(() => {
    scrollWidthSpy.mockRestore();
    clientWidthSpy.mockRestore();
    offsetWidthSpy.mockRestore();
    computedStyleSpy.mockRestore();
  });

  const getAmountSpan = (amount: string) => {
    const span = screen.getByText(amount);
    expect(span.tagName).toBe('SPAN');
    return span;
  };

  it('keeps the max 3.5rem size when the amount fits', () => {
    amountScrollWidth = 200; // fits inside 400 - (40 + 2) = 358 available px
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" />);
    expect(getAmountSpan('$123.45').style.fontSize).toBe('3.5rem');
  });

  it('shrinks the font proportionally for a long amount', () => {
    amountScrollWidth = 450; // needs 450px at 3.5rem; available is 358px
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$21,000,000.12" />);
    // 3.5 * 358 / 450 = 2.784 (rounded to 3 decimals)
    expect(getAmountSpan('$21,000,000.12').style.fontSize).toBe('2.784rem');
  });

  it('clamps at the 2.5rem floor for extreme lengths', () => {
    amountScrollWidth = 3000;
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$1,234,567,890,123,456.78" />);
    expect(getAmountSpan('$1,234,567,890,123,456.78').style.fontSize).toBe('2.5rem');
  });

  it('renders the hidden state at the max size', () => {
    amountScrollWidth = 150;
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" state="hidden" />);
    expect(getAmountSpan('••••••').style.fontSize).toBe('3.5rem');
  });
});

describe('BalanceCard states, delta, and interactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the loading skeleton instead of the amount', () => {
    const { container } = render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" state="loading" />);

    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText('$123.45')).toBeNull();
  });

  it('renders the zero state as $0.00', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" state="zero" />);

    expect(screen.getByText('$0.00')).toBeTruthy();
  });

  it('renders a positive delta pill with the neutral background', () => {
    const { container } = render(
      <BalanceCard
        accountNumber="mtst1aqg...940z"
        amount="$123.45"
        delta={{ absolute: '+$12.34', percentage: '+2.5%', direction: 'positive' }}
      />
    );

    const pill = container.querySelector('.rounded-full');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('balanceCardDeltaPill');
    expect(pill?.className).toContain('bg-[#A8BBA3]');
  });

  it('renders a negative delta pill with the negative background', () => {
    const { container } = render(
      <BalanceCard
        accountNumber="mtst1aqg...940z"
        amount="$123.45"
        delta={{ absolute: '-$5.00', percentage: '-1.0%', direction: 'negative' }}
      />
    );

    expect(container.querySelector('.rounded-full')?.className).toContain('bg-status-negative');
  });

  it('hides the delta pill while loading', () => {
    render(
      <BalanceCard
        accountNumber="mtst1aqg...940z"
        amount="$123.45"
        state="loading"
        delta={{ absolute: '+$1.00', percentage: '+0.1%' }}
      />
    );

    expect(screen.queryByText(/\+0\.1%/)).toBeNull();
  });

  it('fires haptic feedback and onMore when the more button is clicked', () => {
    const onMore = jest.fn();
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" onMore={onMore} />);

    fireEvent.click(screen.getByRole('button', { name: 'balanceCardAccountOptions' }));

    expect(onMore).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('omits the more button when onMore is not provided', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" />);

    expect(screen.queryByRole('button', { name: 'balanceCardAccountOptions' })).toBeNull();
  });

  it('renders a custom currency and the account label', () => {
    render(
      <BalanceCard
        accountNumber="mtst1aqg...940z"
        accountId="mtst1aqgfullaccountid940z"
        amount="$123.45"
        currency="EUR"
      />
    );

    expect(screen.getByText('EUR')).toBeTruthy();
    expect(screen.getByText('balanceCardAccount')).toBeTruthy();
  });

  it('observes row and text and disconnects on unmount when ResizeObserver exists', () => {
    const observe = jest.fn();
    const disconnect = jest.fn();
    class MockResizeObserver {
      observe = observe;
      unobserve = jest.fn();
      disconnect = disconnect;
    }
    const original = (global as any).ResizeObserver;
    (global as any).ResizeObserver = MockResizeObserver;

    const { unmount } = render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" />);
    expect(observe).toHaveBeenCalledTimes(2);

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);

    (global as any).ResizeObserver = original;
  });
});
