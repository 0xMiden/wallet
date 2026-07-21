import React, { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import CleanButton from 'app/atoms/CleanButton';

import SearchField from './SearchField';

// CleanButton pulls in haptics / tippy / i18n; mock it so this stays a focused
// unit test of SearchField and we can assert exactly which props it forwards.
jest.mock('app/atoms/CleanButton', () => ({
  __esModule: true,
  default: jest.fn((props: any) => (
    <button type="button" data-testid="clean-button" onClick={props.onClick}>
      clean
    </button>
  ))
}));

const mockCleanButton = CleanButton as unknown as jest.Mock;

// The `\.svg$` moduleNameMapper renders the search icon as a plain <svg>.
const getInput = () => screen.getByRole('textbox') as HTMLInputElement;
const getSvg = (container: HTMLElement) => container.querySelector('svg') as SVGElement;

describe('SearchField', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a text input with the static attributes and no clean button when empty', () => {
    const { container } = render(<SearchField value="" onValueChange={jest.fn()} />);

    const input = getInput();
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveClass('appearance-none', 'w-full');
    expect(input).toHaveValue('');

    // Search icon is always present.
    expect(getSvg(container)).toBeInTheDocument();

    // value is falsy -> the `Boolean(value) &&` branch renders nothing.
    expect(screen.queryByTestId('clean-button')).not.toBeInTheDocument();
    expect(mockCleanButton).not.toHaveBeenCalled();
  });

  it('renders the clean button when value is non-empty (truthy branch)', () => {
    render(<SearchField value="btc" onValueChange={jest.fn()} />);

    expect(getInput()).toHaveValue('btc');
    expect(screen.getByTestId('clean-button')).toBeInTheDocument();
    expect(mockCleanButton).toHaveBeenCalledTimes(1);
  });

  it('forwards the default bottomOffset and undefined styles to CleanButton', () => {
    render(<SearchField value="x" onValueChange={jest.fn()} />);

    const props = mockCleanButton.mock.calls[0][0];
    expect(props.bottomOffset).toBe('0.45rem');
    expect(props.style).toBeUndefined();
    expect(props.iconStyle).toBeUndefined();
    expect(typeof props.onClick).toBe('function');
  });

  it('forwards a custom bottomOffset and the clean button style props', () => {
    const cleanButtonStyle = { color: 'red' };
    const cleanButtonIconStyle = { color: 'blue' };
    render(
      <SearchField
        value="x"
        onValueChange={jest.fn()}
        bottomOffset="1.25rem"
        cleanButtonStyle={cleanButtonStyle}
        cleanButtonIconStyle={cleanButtonIconStyle}
      />
    );

    const props = mockCleanButton.mock.calls[0][0];
    expect(props.bottomOffset).toBe('1.25rem');
    expect(props.style).toBe(cleanButtonStyle);
    expect(props.iconStyle).toBe(cleanButtonIconStyle);
  });

  it('calls onValueChange with the new input value on change (handleChange)', () => {
    const onValueChange = jest.fn();
    render(<SearchField value="" onValueChange={onValueChange} />);

    fireEvent.change(getInput(), { target: { value: 'hello' } });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('hello');
  });

  it('calls onValueChange with an empty string when the clean button is clicked (handleClean)', () => {
    const onValueChange = jest.fn();
    render(<SearchField value="something" onValueChange={onValueChange} />);

    fireEvent.click(screen.getByTestId('clean-button'));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('');
  });

  it('applies containerClassName, className, and the search-icon class names', () => {
    const { container } = render(
      <SearchField
        value=""
        onValueChange={jest.fn()}
        containerClassName="my-container"
        className="my-input"
        searchIconClassName="my-icon"
        searchIconWrapperClassName="my-icon-wrapper"
      />
    );

    // Outer wrapper gets containerClassName merged with the base classes.
    const outer = container.firstChild as HTMLElement;
    expect(outer).toHaveClass('w-full', 'flex', 'flex-col', 'my-container');

    // Input keeps its base classes plus the custom className.
    expect(getInput()).toHaveClass('appearance-none', 'w-full', 'my-input');

    // Search icon + its wrapper receive the custom class names.
    const icon = getSvg(container);
    expect(icon).toHaveClass('stroke-current', 'my-icon');
    expect(icon.parentElement).toHaveClass('my-icon-wrapper');
  });

  it('spreads the rest props (placeholder, disabled, data-*) onto the input', () => {
    render(
      <SearchField
        value=""
        onValueChange={jest.fn()}
        placeholder="Search assets"
        disabled
        data-testid="search-input"
        maxLength={10}
      />
    );

    const input = getInput();
    expect(input).toHaveAttribute('placeholder', 'Search assets');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('data-testid', 'search-input');
    expect(input).toHaveAttribute('maxlength', '10');
  });

  it('behaves as a controlled field end-to-end: typing shows the clean button, clicking it clears', () => {
    const Wrapper = () => {
      const [value, setValue] = useState('');
      return <SearchField value={value} onValueChange={setValue} />;
    };

    render(<Wrapper />);
    const input = getInput();

    // Initially empty -> no clean button.
    expect(screen.queryByTestId('clean-button')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input).toHaveValue('abc');

    // Now that the value is truthy, the clean button appears.
    const cleanButton = screen.getByTestId('clean-button');
    fireEvent.click(cleanButton);

    // handleClean resets the controlled value, removing the clean button.
    expect(input).toHaveValue('');
    expect(screen.queryByTestId('clean-button')).not.toBeInTheDocument();
  });
});
