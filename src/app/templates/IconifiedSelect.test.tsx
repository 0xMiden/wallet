import React from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import IconifiedSelect, { IconifiedSelectOptionRenderProps } from './IconifiedSelect';

// `lib/ui/Popper` is a sibling dependency that wires the trigger + popup to
// `floating-ui/react` (`useFloating` / `autoUpdate`), which needs a real
// `ResizeObserver` + layout — neither of which jsdom provides. We stub it with
// a faithful, deterministic re-implementation of its render contract: it owns
// the `opened` state and hands `{ opened, setOpened, toggleOpened, ref }` to
// the trigger `children` render-prop and `{ opened, setOpened, toggleOpened }`
// to the `popup` render-prop, rendering BOTH (exactly like the real Popper,
// which always mounts the popup and lets the inner DropdownWrapper's
// CSSTransition gate visibility on `opened`). This keeps IconifiedSelect's own
// logic — the option-menu callbacks, the selected/disabled option branches and
// the SelectButton toggling — fully exercised end to end.
jest.mock('lib/ui/Popper', () => {
  const ReactLib = require('react');
  const MockPopper = ({ popup, children }: any) => {
    const [opened, setOpened] = ReactLib.useState(false);
    const toggleOpened = ReactLib.useCallback(() => setOpened((o: boolean) => !o), []);
    const renderProps = { opened, setOpened, toggleOpened };
    return ReactLib.createElement(
      ReactLib.Fragment,
      null,
      children({ ...renderProps, ref: () => {} }),
      popup(renderProps)
    );
  };
  return {
    __esModule: true,
    default: MockPopper
  };
});

// ---- Test option model + render components ---------------------------------

type Fruit = { id: string; label: string };

const APPLE: Fruit = { id: 'apple', label: 'Apple' };
const BANANA: Fruit = { id: 'banana', label: 'Banana' };
const CHERRY: Fruit = { id: 'cherry', label: 'Cherry' };

const getKey = (o: Fruit) => o.id;

// Distinct text per render-slot so button accessible names don't collide
// between the trigger (uses OptionSelected*) and the menu rows (uses
// OptionInMenuContent / Icon).
const Icon = ({ option }: IconifiedSelectOptionRenderProps<Fruit>) => (
  <span data-testid="menu-icon">icon:{option.id}</span>
);
const OptionSelectedIcon = ({ option }: IconifiedSelectOptionRenderProps<Fruit>) => (
  <span data-testid="selected-icon">selicon:{option.id}</span>
);
const OptionInMenuContent = ({ option }: IconifiedSelectOptionRenderProps<Fruit>) => <span>menu-{option.label}</span>;
const OptionSelectedContent = ({ option }: IconifiedSelectOptionRenderProps<Fruit>) => (
  <span>selected-{option.label}</span>
);

type Props = React.ComponentProps<typeof IconifiedSelect<Fruit>>;

const renderSelect = (overrides: Partial<Props> = {}) => {
  const onChange = jest.fn();
  const props = {
    Icon,
    OptionSelectedIcon,
    OptionInMenuContent,
    OptionSelectedContent,
    getKey,
    options: [APPLE, BANANA, CHERRY],
    value: APPLE,
    onChange,
    title: <div data-testid="title">Choose a fruit</div>,
    ...overrides
  } as Props;
  const utils = render(<IconifiedSelect {...props} />);
  return { ...utils, onChange };
};

// The trigger is the SelectButton showing the current value via the "selected-"
// slots; menu rows use the "menu-" slots, so this name is unique even when open.
const getTrigger = () => screen.getByRole('button', { name: /selected-/ });
const openMenu = async () => {
  fireEvent.click(getTrigger());
  // DropdownWrapper's CSSTransition mounts the rows on the enter transition.
  await waitFor(() => expect(screen.getByRole('button', { name: /menu-Apple/ })).toBeInTheDocument());
};
const menuRow = (label: string) => screen.getByRole('button', { name: new RegExp(`menu-${label}`) });

describe('IconifiedSelect', () => {
  describe('multi-option (dropdown) mode', () => {
    it('renders the title and a dropdown SelectButton (chevron) for the current value', () => {
      renderSelect();

      expect(screen.getByTestId('title')).toHaveTextContent('Choose a fruit');

      const trigger = getTrigger();
      // Selected slots render the current value (APPLE) through the trigger.
      expect(trigger).toHaveTextContent('selicon:apple');
      expect(trigger).toHaveTextContent('selected-Apple');
      // dropdown=true → cursor-pointer + the chevron svg (auto-mocked → <svg>).
      expect(trigger).toHaveClass('cursor-pointer');
      expect(trigger.querySelector('svg')).toBeInTheDocument();
    });

    it('keeps the option rows unmounted until the trigger is clicked, then reveals them', async () => {
      renderSelect();

      // Closed: DropdownWrapper (unmountOnExit) renders null → only the trigger.
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: /menu-Apple/ })).toBeNull();

      await openMenu();

      // One trigger + three option rows.
      expect(screen.getByRole('button', { name: /menu-Apple/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /menu-Banana/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /menu-Cherry/ })).toBeInTheDocument();
    });

    it('renders each option row with its menu Icon + content and the selected row styling', async () => {
      renderSelect();
      await openMenu();

      const selectedRow = menuRow('Apple');
      // Selected row (getKey(option) === getKey(value)) → bg-chip-bg, autoFocus,
      // cursor-pointer, enabled.
      expect(selectedRow).toHaveClass('bg-chip-bg', 'cursor-pointer');
      expect(selectedRow).not.toHaveClass('opacity-25');
      expect(selectedRow).not.toBeDisabled();
      // Menu rows render the menu Icon + OptionInMenuContent, not the selected ones.
      expect(within(selectedRow).getByTestId('menu-icon')).toHaveTextContent('icon:apple');

      // Non-selected, enabled row → hover style, no selected background.
      const bananaRow = menuRow('Banana');
      expect(bananaRow).toHaveClass('hover:bg-gray-100', 'cursor-pointer');
      expect(bananaRow).not.toHaveClass('bg-chip-bg');
      expect(bananaRow).not.toBeDisabled();
    });

    it('calls onChange with the newly picked (different) option', async () => {
      const { onChange } = renderSelect();
      await openMenu();

      fireEvent.click(menuRow('Banana'));

      // getKey(BANANA) !== getKey(APPLE) → onChange fires with the new value.
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(BANANA);
    });

    it('does NOT call onChange when the already-selected option is re-picked', async () => {
      const { onChange } = renderSelect();
      await openMenu();

      // Re-click the current value: getKey(APPLE) === getKey(APPLE) → no onChange,
      // but the menu still closes (setOpened(false)).
      fireEvent.click(menuRow('Apple'));

      expect(onChange).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('button', { name: /menu-Apple/ })).toBeNull());
    });

    it('safely no-ops when a different option is picked without an onChange handler', async () => {
      // onChange undefined exercises the `onChange?.(newValue)` optional-call branch.
      renderSelect({ onChange: undefined });
      await openMenu();

      expect(() => fireEvent.click(menuRow('Banana'))).not.toThrow();
      // Menu closes regardless of the (absent) handler.
      await waitFor(() => expect(screen.queryByRole('button', { name: /menu-Banana/ })).toBeNull());
    });

    it('renders disabled option rows (isDisabled) as non-interactive and does not fire onChange', async () => {
      const isDisabled = (o: Fruit) => o.id === CHERRY.id;
      const { onChange } = renderSelect({ isDisabled });
      await openMenu();

      const cherryRow = menuRow('Cherry');
      // disabled → opacity-25 + cursor-default, actually disabled, no hover class,
      // and its onClick is stripped to undefined.
      expect(cherryRow).toBeDisabled();
      expect(cherryRow).toHaveClass('opacity-25', 'cursor-default');
      expect(cherryRow).not.toHaveClass('hover:bg-gray-100');

      fireEvent.click(cherryRow);
      expect(onChange).not.toHaveBeenCalled();

      // A non-disabled row still works when isDisabled is provided.
      fireEvent.click(menuRow('Banana'));
      expect(onChange).toHaveBeenCalledWith(BANANA);
    });

    it('toggles the menu closed when the trigger is clicked again', async () => {
      renderSelect();
      await openMenu();
      expect(screen.getByRole('button', { name: /menu-Apple/ })).toBeInTheDocument();

      // Second trigger click → toggleOpened flips opened back to false.
      fireEvent.click(getTrigger());
      await waitFor(() => expect(screen.queryByRole('button', { name: /menu-Apple/ })).toBeNull());
    });

    it('supports numeric keys from getKey', async () => {
      const numeric: Fruit[] = [
        { id: '1', label: 'One' },
        { id: '2', label: 'Two' }
      ];
      const onChange = jest.fn();
      render(
        <IconifiedSelect
          Icon={Icon}
          OptionSelectedIcon={OptionSelectedIcon}
          OptionInMenuContent={OptionInMenuContent}
          OptionSelectedContent={OptionSelectedContent}
          getKey={(o: any) => Number(o.id)}
          options={numeric}
          value={numeric[0]!}
          onChange={onChange}
          title={<div>t</div>}
        />
      );
      fireEvent.click(screen.getByRole('button'));
      await waitFor(() => expect(screen.getByRole('button', { name: /menu-Two/ })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /menu-Two/ }));
      expect(onChange).toHaveBeenCalledWith(numeric[1]);
    });
  });

  describe('single-option (static) mode', () => {
    it('renders only a non-dropdown SelectButton (no chevron, cursor-default, no Popper)', () => {
      renderSelect({ options: [APPLE], value: APPLE });

      expect(screen.getByTestId('title')).toBeInTheDocument();

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(1);

      const button = buttons[0]!;
      expect(button).toHaveTextContent('selicon:apple');
      expect(button).toHaveTextContent('selected-Apple');
      // dropdown falsy → cursor-default and no chevron svg.
      expect(button).toHaveClass('cursor-default');
      expect(button).not.toHaveClass('cursor-pointer');
      expect(button.querySelector('svg')).toBeNull();
    });

    it('renders the static button when the options list is empty', () => {
      // options.length (0) is not > 1 → the static branch still renders a button.
      renderSelect({ options: [], value: APPLE });
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(screen.getByRole('button')).toHaveTextContent('selected-Apple');
    });
  });
});
