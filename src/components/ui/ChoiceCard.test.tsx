import React, { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import { tabBarMotion } from 'lib/animation';
import { hapticSelection } from 'lib/mobile/haptics';

import ChoiceCardGroupDefault, { ChoiceCardGroup, ChoiceCardGroupProps, ChoiceCardItem } from './ChoiceCard';

let mockReduce = false;

// motion.* render as plain elements that surface what framer would receive: the press target and
// the check's pop target, with `onAnimationComplete` routed to transitionend.
jest.mock('framer-motion', () => {
  const ReactActual = jest.requireActual('react');
  const make = (tag: string) =>
    ReactActual.forwardRef(
      (
        {
          transition,
          animate,
          whileTap,
          onAnimationComplete,
          children,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode },
        ref: React.Ref<HTMLElement>
      ) =>
        ReactActual.createElement(
          tag,
          {
            ref,
            'data-transition': JSON.stringify(transition),
            'data-animate': JSON.stringify(animate),
            'data-while-tap': JSON.stringify(whileTap),
            onTransitionEnd: onAnimationComplete,
            ...props
          },
          children
        )
    );
  return {
    ...jest.requireActual('framer-motion'),
    motion: { div: make('div'), span: make('span'), button: make('button'), path: make('path') },
    useReducedMotion: () => mockReduce
  };
});

jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn() }));

const mockHapticSelection = jest.mocked(hapticSelection);

type Choice = 'oz' | 'gateway' | 'kodax' | 'none';

const items: ChoiceCardItem<Choice>[] = [
  {
    id: 'oz',
    title: 'OpenZeppelin',
    subtitle: 'Operated by OpenZeppelin · US-EAST',
    leading: <svg data-testid="logo-oz" />,
    badge: <span data-testid="badge-current">Current</span>,
    'data-testid': 'choice-oz',
    data: { 'data-guardian-endpoint': 'https://oz.example' }
  },
  { id: 'gateway', title: 'Gateway', subtitle: 'Operated by Gateway · EU' },
  { id: 'kodax', title: 'Kodax', disabled: true, 'aria-label': 'Kodax, offline' },
  { id: 'none', title: 'No guardian' }
];

const Owner: React.FC<{ initial?: Choice | null; onChange?: (id: Choice) => void }> = ({
  initial = 'oz',
  onChange
}) => {
  const [value, setValue] = useState<Choice | null>(initial);
  return (
    <ChoiceCardGroup
      items={items}
      value={value}
      onChange={id => {
        setValue(id);
        onChange?.(id);
      }}
      aria-label="Guardians"
    />
  );
};

const renderGroup = (props: Partial<ChoiceCardGroupProps<Choice>> = {}) =>
  render(<ChoiceCardGroup items={items} value="oz" onChange={jest.fn()} aria-label="Guardians" {...props} />);

const radio = (name: string) => screen.getByRole('radio', { name });

beforeEach(() => {
  mockReduce = false;
  mockHapticSelection.mockClear();
});

describe('ChoiceCardGroup', () => {
  it('exports the group as the default export', () => {
    expect(ChoiceCardGroupDefault).toBe(ChoiceCardGroup);
  });

  it('renders a labelled radiogroup of flat fill cards with no border', () => {
    renderGroup();
    const group = screen.getByRole('radiogroup', { name: 'Guardians' });
    expect(group).toHaveClass('grid', 'auto-rows-fr', 'gap-3');
    const card = screen.getByTestId('choice-oz');
    expect(card).toHaveClass('rounded-2xl', 'bg-fill');
    expect(card.className).not.toMatch(/\bborder\b/);
  });

  it('draws the title, subtitle, leading visual, badge and forwards data attributes', () => {
    renderGroup();
    const card = screen.getByTestId('choice-oz');
    expect(card).toHaveTextContent('OpenZeppelin');
    expect(card).toHaveTextContent('Operated by OpenZeppelin · US-EAST');
    expect(screen.getByTestId('logo-oz').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('badge-current')).toBeInTheDocument();
    expect(card).toHaveAttribute('data-guardian-endpoint', 'https://oz.example');
  });

  it('names a card by its title and describes it by its badge and subtitle', () => {
    renderGroup();
    expect(screen.getByTestId('choice-oz')).toHaveAccessibleName('OpenZeppelin');
    expect(screen.getByTestId('choice-oz')).toHaveAccessibleDescription('Current Operated by OpenZeppelin · US-EAST');
    expect(radio('Kodax, offline')).toBeInTheDocument();
  });

  it('marks the chosen card with aria-checked, the accent ring and a check', () => {
    renderGroup();
    const oz = radio('OpenZeppelin');
    expect(oz).toHaveAttribute('aria-checked', 'true');
    expect(oz).toHaveAttribute('data-state', 'checked');
    expect(oz).toHaveClass('ring-2', 'ring-inset', 'ring-accent-primary');
    expect(oz.querySelector('svg:not([data-testid])')).not.toBeNull();

    const gateway = radio('Gateway');
    expect(gateway).toHaveAttribute('aria-checked', 'false');
    expect(gateway).not.toHaveClass('ring-accent-primary');
  });

  it('selects on tap with one selection haptic, and a tap on the chosen card is silent', () => {
    const onChange = jest.fn();
    render(<Owner onChange={onChange} />);

    fireEvent.click(radio('Gateway'));
    expect(onChange).toHaveBeenCalledWith('gateway');
    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
    expect(radio('Gateway')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(radio('Gateway'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(mockHapticSelection).toHaveBeenCalledTimes(1);
  });

  it('disables an option: out of reach, dimmed, and never selected', () => {
    const onChange = jest.fn();
    renderGroup({ onChange });
    const kodax = radio('Kodax, offline');
    expect(kodax).toBeDisabled();
    fireEvent.click(kodax);
    expect(onChange).not.toHaveBeenCalled();
    expect(kodax).not.toHaveAttribute('data-while-tap');
  });

  it('keeps only the chosen card in the tab order', () => {
    renderGroup({ value: 'gateway' });
    expect(radio('Gateway')).toHaveAttribute('tabindex', '0');
    expect(radio('OpenZeppelin')).toHaveAttribute('tabindex', '-1');
    expect(radio('No guardian')).toHaveAttribute('tabindex', '-1');
  });

  it('puts the first choosable card in the tab order when nothing is chosen', () => {
    renderGroup({ value: null });
    expect(radio('OpenZeppelin')).toHaveAttribute('tabindex', '0');
    screen.getAllByRole('radio').forEach(r => expect(r).toHaveAttribute('aria-checked', 'false'));
  });

  it('moves focus and the choice together with the arrow keys, skipping disabled options', () => {
    const onChange = jest.fn();
    render(<Owner onChange={onChange} />);
    const group = screen.getByRole('radiogroup');

    radio('OpenZeppelin').focus();
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('gateway');
    expect(radio('Gateway')).toHaveFocus();

    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('none');
    expect(radio('No guardian')).toHaveFocus();

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('oz');

    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('none');

    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('oz');

    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('none');
    expect(mockHapticSelection).toHaveBeenCalledTimes(6);
  });

  it('ignores other keys', () => {
    const onChange = jest.fn();
    render(<Owner onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('dips a pressed card on the tab-bar press and pops the check when a card becomes chosen', () => {
    render(<Owner />);
    expect(radio('Gateway')).toHaveAttribute(
      'data-while-tap',
      JSON.stringify({ scale: tabBarMotion.pressScale, transition: tabBarMotion.press })
    );

    const check = (name: string) => radio(name).querySelector('[data-pop]');
    expect(check('OpenZeppelin')).toHaveAttribute('data-pop', 'rest');

    fireEvent.click(radio('Gateway'));
    expect(check('Gateway')).toHaveAttribute('data-pop', 'pop');
    expect(JSON.parse(check('Gateway')!.getAttribute('data-animate')!)).toEqual({ scale: tabBarMotion.iconPopScale });

    fireEvent.transitionEnd(check('Gateway')!);
    expect(check('Gateway')).toHaveAttribute('data-pop', 'rest');
  });

  it('under reduced motion a press does not scale and nothing pops', () => {
    mockReduce = true;
    render(<Owner />);
    expect(radio('Gateway')).not.toHaveAttribute('data-while-tap');
    fireEvent.click(radio('Gateway'));
    const check = radio('Gateway').querySelector('[data-pop]');
    expect(check).toHaveAttribute('data-pop', 'rest');
    expect(JSON.parse(check!.getAttribute('data-animate')!)).toEqual({ scale: 1 });
  });
});
