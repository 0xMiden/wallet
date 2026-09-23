import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { BalanceCard, BalanceDeltaDirection, resolveDeltaDirection } from './BalanceCard';

jest.mock('react-i18next', () => ({
  // Interpolated values are appended, so a test can read what the pill was given.
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? [key, ...Object.values(values)].join(' ') : key)
  })
}));

jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid="icon" data-name={name} className={className} />
  ),
  IconName: {
    CopyNew: 'CopyNew',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    Checkmark: 'Checkmark',
    MidenLogo: 'MidenLogo',
    SettingsNew: 'SettingsNew',
    Edit: 'Edit'
  }
}));

// The canonical CopyButton is used for real (not stubbed) here — it wraps `children` in its own
// `<span aria-live>`, which is exactly the structure the account row's layout has to survive (see
// "keeps the label and icon laid out..." below), so a stub that just re-parents `children`
// straight under a `<button>` would hide that class of bug. Mock only what the real component
// needs: the clipboard write and the tap haptic (haptic mocked below, same as before).
const mockClipboardWrite = jest.fn().mockResolvedValue(undefined);
jest.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: (...args: unknown[]) => mockClipboardWrite(...args) }
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

const ADDRESS = 'mtst1aqg...940z';

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

    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText('$123.45')).toBeNull();
  });

  it('renders the zero state as $0.00', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" state="zero" />);

    expect(screen.getByText('$0.00')).toBeTruthy();
  });

  // The pill is a darker well of the card's own color, never a status hue (the sage green clashed
  // with every card color and held white text at 2.2:1): direction is the arrow and the sign.
  // The component keeps its delta support for when a real source lands; with none passed it simply
  // shows no pill, which is what Home relies on.
  it('renders no change pill when the caller passes no delta', () => {
    render(<BalanceCard accountNumber="1" accountId="0xabc" amount="$100.00" />);

    expect(screen.queryByTestId('balance-card-delta')).toBeNull();
  });

  it('renders a positive change on the card-ink pill with an up arrow and its sign', () => {
    render(
      <BalanceCard
        accountNumber={ADDRESS}
        amount="$123.45"
        delta={{ absolute: '+$12.34', percentage: '+2.5%', direction: 'positive' }}
      />
    );

    const pill = screen.getByTestId('balance-card-delta');
    expect(pill).toHaveClass('bg-surface-balance-pill', 'text-surface-balance-fg');
    expect(pill.className).not.toMatch(/status-(positive|negative)/);
    expect(pill).toHaveTextContent('balanceCardDeltaPill +$12.34 +2.5%');
    expect(pill.querySelector('[data-name="ArrowUp"]')).not.toBeNull();
  });

  it('renders a negative change with a down arrow and its sign, on the same pill', () => {
    render(
      <BalanceCard
        accountNumber={ADDRESS}
        amount="$123.45"
        delta={{ absolute: '-$5.00', percentage: '-1.0%', direction: 'negative' }}
      />
    );

    const pill = screen.getByTestId('balance-card-delta');
    expect(pill).toHaveClass('bg-surface-balance-pill');
    expect(pill).toHaveTextContent('balanceCardDeltaPill -$5.00 -1.0%');
    expect(pill.querySelector('[data-name="ArrowDown"]')).not.toBeNull();
  });

  it('renders a zero change as neutral: no arrow and no sign, even when the caller says positive', () => {
    render(
      <BalanceCard
        accountNumber={ADDRESS}
        amount="$123.45"
        delta={{ absolute: '+0.00', percentage: '0.00%', direction: 'positive' }}
      />
    );

    const pill = screen.getByTestId('balance-card-delta');
    expect(pill).toHaveTextContent('balanceCardDeltaPill 0.00 0.00%');
    expect(pill.querySelector('[data-name^="Arrow"]')).toBeNull();
  });

  it('keeps the plain brand card color with a card-ink hairline footer, no scrim or darker strip', () => {
    const { container } = render(<BalanceCard accountNumber={ADDRESS} amount="$123.45" />);

    const card = container.firstElementChild;
    expect(card).toHaveClass('bg-card-slate');
    expect(container.querySelector('[class*="scrim"]')).toBeNull();
    expect(container.querySelector('[class*="-deep"]')).toBeNull();
    expect(container.querySelector('.border-dashed')).toBeNull();
    expect(screen.getByTestId('balance-card-footer')).toHaveClass('border-t', 'border-surface-balance-rule');
  });

  it('draws the label as a 13px bold sentence-case label in the full-strength card ink', () => {
    render(<BalanceCard accountNumber={ADDRESS} amount="$123.45" />);

    const label = screen.getByTestId('balance-card-label');
    expect(label).toHaveTextContent('balanceCardTotalBalance');
    expect(label).toHaveClass('text-label');
    expect(label.className).not.toMatch(/muted|opacity/);
  });

  it('sets the currency as a 22px bold unit on the amount baseline, in the full-strength ink', () => {
    render(<BalanceCard accountNumber={ADDRESS} amount="$123.45" />);

    const currency = screen.getByTestId('balance-card-currency');
    expect(currency).toHaveTextContent('USD');
    expect(currency).toHaveClass('text-entry-unit');
    expect(currency.className).not.toMatch(/muted|opacity/);
    expect(currency.parentElement).toHaveClass('items-baseline');
    expect(currency.previousElementSibling).toHaveTextContent('$123.45');
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

  it('fires haptic feedback and onMore when the card is tapped', () => {
    const onMore = jest.fn();
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" onMore={onMore} />);

    fireEvent.click(screen.getByRole('button', { name: 'balanceCardAccountOptions' }));

    expect(onMore).toHaveBeenCalledTimes(1);
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  // The copy control is the shared CopyButton (rendered for real, not stubbed): the address is its
  // label and the animated glyph trails it.
  const copyControl = () => screen.getByTestId('balance-card-copy-address');
  const presentGlyph = () => copyControl().querySelector('[data-copy-icon] [data-present="true"]');

  it('renders the shared copy glyph after the address and no edit glyph: the whole card is the account-options control', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" onMore={jest.fn()} />);

    expect(presentGlyph()).toHaveAttribute('data-copy-state', 'idle');
    expect(presentGlyph()?.querySelector('[data-name="CopyNew"]')).toBeInTheDocument();
    // 16px, the size the footer used before the shared glyph.
    expect(copyControl().querySelector('[data-copy-icon]')).toHaveClass('w-4', 'h-4');

    expect(document.querySelector('[data-name="Edit"]')).toBeNull();
  });

  it('lays the address out before the glyph in one truncating row, in the footer type', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" onMore={jest.fn()} />);

    const row = copyControl().querySelector('[aria-live="polite"]')!;
    expect(row).toHaveClass('flex', 'items-center', 'gap-1.5', 'min-w-0', 'text-label');
    expect(row.children[0]).toHaveAttribute('data-copy-label');
    expect(screen.getByText(ADDRESS)).toHaveClass('truncate');
    expect(row.children[1]).toHaveAttribute('data-copy-icon');
  });

  it('morphs the copy glyph to a check while the account id is copied, keeping the address in place', async () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" accountId="mtst1aqgfullaccountid940z" amount="$123.45" />);

    await act(async () => {
      fireEvent.click(screen.getByText(ADDRESS));
    });

    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'mtst1aqgfullaccountid940z' });
    expect(presentGlyph()).toHaveAttribute('data-copy-state', 'copied');
    expect(presentGlyph()?.querySelector('[data-name="Checkmark"]')).toBeInTheDocument();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    // The glyph carries no text, so the state is in the accessible name.
    expect(copyControl()).toHaveAccessibleName('balanceCardAddressCopied');
  });

  // A role=button container presents its children as decoration, so the balance and the copy
  // control disappeared for assistive tech and one focusable button sat inside another. The
  // options target is a real button under the content instead, which also brings native keyboard
  // activation back in place of a hand-rolled Enter/Space handler.
  it('keeps the balance and the copy control outside the account-options control', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" onMore={jest.fn()} />);

    const options = screen.getByRole('button', { name: 'balanceCardAccountOptions' });
    expect(options.tagName).toBe('BUTTON');
    expect(options.querySelectorAll('button')).toHaveLength(0);
    expect(options).not.toContainElement(screen.getByText('$123.45'));
    expect(options).not.toContainElement(screen.getByText(ADDRESS));
    expect(screen.getByText(ADDRESS).closest('[role="button"]')).toBeNull();
  });

  it('keeps a visible focus ring and lets a tap anywhere on the card reach the options', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" onMore={jest.fn()} />);

    // The ring is inset because the card clips to this button's own border box.
    const options = screen.getByRole('button', { name: 'balanceCardAccountOptions' });
    expect(options).toHaveClass('focus-visible:ring-2', 'focus-visible:ring-inset');

    // These classes ARE the tap-anywhere behaviour: the content lets taps through to the button
    // underneath, and only the copy control takes its own. jsdom dispatches clicks at the target
    // whatever pointer-events says, so without this assertion dropping them fails no test.
    const balance = screen.getByText('$123.45');
    expect(balance.closest('.pointer-events-none')).not.toBeNull();
    expect(screen.getByText(ADDRESS).closest('.pointer-events-auto')).not.toBeNull();
  });

  it('does not open the account options when the address is copied', async () => {
    const onMore = jest.fn();
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" onMore={onMore} />);

    await act(async () => {
      fireEvent.click(screen.getByText(ADDRESS));
    });

    expect(onMore).not.toHaveBeenCalled();
  });

  it('is not a control when onMore is not provided', () => {
    render(<BalanceCard accountNumber="mtst1aqg...940z" amount="$123.45" />);

    expect(screen.queryByRole('button', { name: 'balanceCardAccountOptions' })).toBeNull();
  });

  it('copies from a 44px target named for what it does, showing the address without an "Address:" prefix', () => {
    render(<BalanceCard accountNumber={ADDRESS} amount="$123.45" />);

    const copy = screen.getByTestId('balance-card-copy-address');
    expect(copy).toHaveAccessibleName('balanceCardCopyAddress');
    expect(copy).toHaveClass('min-h-11');
    expect(copy).toHaveTextContent(ADDRESS);
    expect(copy.textContent).not.toMatch(/balanceCardAccount/);
  });

  it('shows the alias before the address and still copies the full account id', async () => {
    render(
      <BalanceCard
        accountNumber={ADDRESS}
        accountId="mtst1aqgfullaccountid940z"
        accountAlias="alice.miden"
        amount="$123.45"
      />
    );

    const label = screen.getByText(`balanceCardAccountWithName alice.miden ${ADDRESS}`);
    expect(screen.queryByText(ADDRESS)).toBeNull();

    await act(async () => {
      fireEvent.click(label);
    });

    expect(mockClipboardWrite).toHaveBeenCalledWith({ string: 'mtst1aqgfullaccountid940z' });
  });

  it('shows the address alone when no alias is given', () => {
    render(<BalanceCard accountNumber={ADDRESS} amount="$123.45" />);

    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.queryByText(/balanceCardAccountWithName/)).toBeNull();
  });

  it('shows the account name beside the address when given one', () => {
    render(<BalanceCard accountNumber={ADDRESS} accountName="Account 1" amount="$123.45" />);

    expect(screen.getByTestId('balance-card-account-name')).toHaveTextContent('Account 1');
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
    expect(screen.getByText(ADDRESS)).toBeTruthy();
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

describe('resolveDeltaDirection', () => {
  const cases: Array<[Parameters<typeof resolveDeltaDirection>[0], BalanceDeltaDirection]> = [
    [{ percentage: '+2.5%', direction: 'positive' }, 'positive'],
    [{ percentage: '-1.0%', direction: 'negative' }, 'negative'],
    [{ percentage: '0.00%', direction: 'positive' }, 'neutral'],
    [{ percentage: '-0.00%', direction: 'negative' }, 'neutral'],
    [{ percentage: '\u22123.1%' }, 'negative'],
    [{ percentage: '4%' }, 'positive'],
    [{ percentage: '—' }, 'neutral']
  ];

  it.each(cases)('%o is %s', (delta, expected) => {
    expect(resolveDeltaDirection(delta)).toBe(expected);
  });
});
