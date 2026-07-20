import React from 'react';

import { render, screen, within } from '@testing-library/react';

import { Calendar, CalendarDayButton } from './calendar';

/**
 * Build a minimal RDP `CalendarDay`-shaped object. The component only ever
 * touches `day.date`, so a plain object with a `date` field is enough for a
 * direct render of `CalendarDayButton`.
 */
const makeDay = (date: Date) => ({ date, displayMonth: date }) as never;

/** Grab the calendar Root element rendered by the custom `Root` component. */
const getRoot = (container: HTMLElement) => container.querySelector('[data-slot="calendar"]');

describe('Calendar', () => {
  it('renders the calendar root, a grid and the left/right nav chevrons with defaults', () => {
    const { container } = render(<Calendar />);

    const root = getRoot(container);
    expect(root).not.toBeNull();
    // Base classes from the default `className` argument are applied to the root.
    expect(root).toHaveClass('bg-white', 'p-2', 'group/calendar');

    // The month grid renders.
    expect(screen.getByRole('grid')).toBeInTheDocument();

    // Nav renders a previous (left) and next (right) chevron; both flow through
    // the `Chevron` component's left/right branches and become `cn-rtl-flip` svgs.
    const flipChevrons = container.querySelectorAll('svg.cn-rtl-flip');
    expect(flipChevrons.length).toBeGreaterThanOrEqual(2);
    flipChevrons.forEach(svg => expect(svg.getAttribute('class')).toContain('size-4'));

    // With the default `captionLayout="label"` there are no dropdowns, and the
    // caption label uses the plain text-sm styling branch.
    expect(container.querySelector('select')).toBeNull();
    const captionLabel = container.querySelector('.rdp-caption_label');
    expect(captionLabel?.getAttribute('class')).toContain('text-sm');
  });

  it('merges a caller className and passes custom classNames through the classNames override', () => {
    const { container } = render(<Calendar className="my-calendar-class" classNames={{ month: 'my-month-class' }} />);

    const root = getRoot(container);
    // The caller className is forwarded onto the root element alongside the base classes.
    expect(root?.getAttribute('class')).toContain('my-calendar-class');

    // The `...classNames` spread lets a caller override win for the `month` slot.
    expect(container.querySelector('.my-month-class')).not.toBeNull();
  });

  it('honours an explicit buttonVariant and showOutsideDays=false', () => {
    const { container } = render(<Calendar buttonVariant="outline" showOutsideDays={false} />);

    // The outline variant class lands on the previous/next nav buttons.
    const navButton = container.querySelector('.rdp-button_previous');
    expect(navButton?.getAttribute('class')).toContain('border-border-light');
    expect(container.querySelector('[data-slot="calendar"]')).not.toBeNull();
  });

  it('renders week numbers (showWeekNumber branch) via the custom WeekNumber component', () => {
    const { container } = render(<Calendar showWeekNumber defaultMonth={new Date(2024, 0, 1)} />);

    // A week-number header cell is rendered when showWeekNumber is on.
    expect(container.querySelector('.rdp-week_number_header')).not.toBeNull();
    // The custom WeekNumber component wraps its children in a centering div.
    const weekNumberCell = container.querySelector('.rdp-week_number');
    expect(weekNumberCell).not.toBeNull();
    expect(weekNumberCell?.querySelector('div')).not.toBeNull();
  });

  it('renders month/year dropdowns, the down chevron branch and the default formatMonthDropdown', () => {
    const { container } = render(<Calendar captionLayout="dropdown" defaultMonth={new Date(2024, 0, 1)} />);

    // Dropdown mode renders <select> elements.
    const selects = container.querySelectorAll('select');
    expect(selects.length).toBeGreaterThanOrEqual(1);

    // The Dropdown component renders a "down" chevron: an svg WITHOUT cn-rtl-flip.
    const downChevrons = Array.from(container.querySelectorAll('svg')).filter(
      svg => !svg.getAttribute('class')?.includes('cn-rtl-flip')
    );
    expect(downChevrons.length).toBeGreaterThanOrEqual(1);
    downChevrons.forEach(svg => expect(svg.getAttribute('class')).toContain('size-4'));

    // The default `formatMonthDropdown` renders short month labels (e.g. "Jan").
    const monthSelect = selects[0];
    expect(within(monthSelect).getByText('Jan')).toBeInTheDocument();

    // The non-label caption branch styling is applied.
    const captionLabel = container.querySelector('.rdp-caption_label');
    expect(captionLabel?.getAttribute('class')).toContain('cn-calendar-caption-label');
  });

  it('lets a caller override formatMonthDropdown via the formatters spread', () => {
    const { container } = render(
      <Calendar
        captionLayout="dropdown"
        defaultMonth={new Date(2024, 0, 1)}
        formatters={{ formatMonthDropdown: () => 'MONTHX' }}
      />
    );

    const monthSelect = container.querySelector('select');
    expect(monthSelect).not.toBeNull();
    expect(within(monthSelect as HTMLElement).getAllByText('MONTHX').length).toBeGreaterThanOrEqual(1);
  });

  it('applies a caller-supplied locale to the month dropdown formatter', () => {
    const { container } = render(
      <Calendar captionLayout="dropdown" defaultMonth={new Date(2024, 0, 1)} locale={{ code: 'en-US' }} />
    );

    const monthSelect = container.querySelector('select');
    expect(within(monthSelect as HTMLElement).getByText('Jan')).toBeInTheDocument();
  });

  it('lets a caller replace a component through the components spread', () => {
    render(<Calendar components={{ Nav: () => <div data-testid="custom-nav">nav</div> }} />);

    // The overridden Nav wins over the default nav/chevrons.
    expect(screen.getByTestId('custom-nav')).toBeInTheDocument();
  });

  it('renders selected day buttons through the DayButton -> CalendarDayButton wrapper', () => {
    const { container } = render(<Calendar mode="single" selected={new Date(2024, 0, 15)} defaultMonth={new Date(2024, 0, 1)} />);

    // Day buttons carry the data-day attribute set by CalendarDayButton.
    const dayButtons = container.querySelectorAll('button[data-day]');
    expect(dayButtons.length).toBeGreaterThan(0);

    // The selected single day gets data-selected-single="true".
    const selected = container.querySelector('button[data-selected-single="true"]');
    expect(selected).not.toBeNull();
  });
});

describe('CalendarDayButton', () => {
  it('renders a ghost/icon button carrying the localized data-day and default single-day data attrs', () => {
    const date = new Date(2024, 0, 15);
    render(<CalendarDayButton day={makeDay(date)} modifiers={{} as never} aria-label="day-15" />);

    const btn = screen.getByRole('button', { name: 'day-15' });
    expect(btn).toHaveAttribute('data-slot', 'button');
    expect(btn).toHaveAttribute('data-variant', 'ghost');
    expect(btn).toHaveAttribute('data-size', 'icon');
    // No locale -> toLocaleDateString(undefined).
    expect(btn).toHaveAttribute('data-day', date.toLocaleDateString(undefined));
    // With no modifiers, `modifiers.selected && ...` short-circuits to
    // `undefined`, so React omits the data attribute entirely.
    expect(btn).not.toHaveAttribute('data-selected-single');
  });

  it('uses the provided locale code for the data-day attribute', () => {
    const date = new Date(2024, 0, 15);
    render(<CalendarDayButton day={makeDay(date)} modifiers={{} as never} locale={{ code: 'en-GB' }} aria-label="d" />);

    expect(screen.getByRole('button', { name: 'd' })).toHaveAttribute(
      'data-day',
      date.toLocaleDateString('en-GB')
    );
  });

  it('marks a plain selected day as data-selected-single=true', () => {
    render(<CalendarDayButton day={makeDay(new Date(2024, 0, 15))} modifiers={{ selected: true } as never} aria-label="d" />);

    expect(screen.getByRole('button', { name: 'd' })).toHaveAttribute('data-selected-single', 'true');
  });

  it.each([
    ['range_start', { selected: true, range_start: true }],
    ['range_end', { selected: true, range_end: true }],
    ['range_middle', { selected: true, range_middle: true }]
  ] as const)(
    'treats a %s day as NOT single-selected and reflects the range modifier',
    (modKey, modifiers) => {
      render(
        <CalendarDayButton day={makeDay(new Date(2024, 0, 15))} modifiers={modifiers as never} aria-label="d" />
      );

      const btn = screen.getByRole('button', { name: 'd' });
      // Any range membership excludes the single-selected styling.
      expect(btn).toHaveAttribute('data-selected-single', 'false');
      expect(btn).toHaveAttribute(`data-${modKey.replace('_', '-')}`, 'true');
    }
  );

  it('runs the focus effect when modifiers.focused is true without crashing', () => {
    // Button is a plain function component (no forwardRef in React 18), so the
    // ref stays null and `ref.current?.focus()` is a safe no-op — this exercises
    // the truthy branch of the focus effect.
    const { rerender } = render(
      <CalendarDayButton day={makeDay(new Date(2024, 0, 15))} modifiers={{ focused: true } as never} aria-label="d" />
    );
    expect(screen.getByRole('button', { name: 'd' })).toBeInTheDocument();

    // Re-render with focused=false to cover the falsy branch of the effect.
    rerender(
      <CalendarDayButton day={makeDay(new Date(2024, 0, 15))} modifiers={{ focused: false } as never} aria-label="d" />
    );
    expect(screen.getByRole('button', { name: 'd' })).toBeInTheDocument();
  });

  it('merges a caller className onto the day button', () => {
    render(
      <CalendarDayButton
        day={makeDay(new Date(2024, 0, 15))}
        modifiers={{} as never}
        className="my-day-class"
        aria-label="d"
      />
    );

    expect(screen.getByRole('button', { name: 'd' })).toHaveClass('my-day-class');
  });
});
