import React from 'react';

import { render, screen } from '@testing-library/react';

import { BalanceCard } from './BalanceCard';

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
    amountScrollWidth = 800; // needs 800px at 3.5rem; available is 358px
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$21,000,000.12" />);
    // 3.5 * 358 / 800 = 1.566 (rounded to 3 decimals)
    expect(getAmountSpan('$21,000,000.12').style.fontSize).toBe('1.566rem');
  });

  it('clamps at the 1.5rem floor for extreme lengths', () => {
    amountScrollWidth = 3000;
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$1,234,567,890,123,456.78" />);
    expect(getAmountSpan('$1,234,567,890,123,456.78').style.fontSize).toBe('1.5rem');
  });

  it('renders the hidden state at the max size', () => {
    amountScrollWidth = 150;
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" state="hidden" />);
    expect(getAmountSpan('••••••').style.fontSize).toBe('3.5rem');
  });
});
