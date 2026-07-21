import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import SearchInputDefault, { SearchInput } from './SearchInput';

// The component depends only on React + clsx, so no module mocks are needed.

const getInput = () => screen.getByRole('textbox') as HTMLInputElement;

describe('SearchInput — exports & defaults', () => {
  it('exposes the same component as the default and named export', () => {
    expect(SearchInputDefault).toBe(SearchInput);
  });

  it('renders a text input wired to the value prop', () => {
    render(<SearchInput value="hello" onChange={jest.fn()} />);

    const input = getInput();
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('text');
    expect(input.value).toBe('hello');
  });

  it('uses the default "Search" placeholder and mirrors it into aria-label', () => {
    render(<SearchInput value="" onChange={jest.fn()} />);

    const input = getInput();
    expect(input.getAttribute('placeholder')).toBe('Search');
    expect(input.getAttribute('aria-label')).toBe('Search');
    // aria-label default also makes the input queryable by that accessible name.
    expect(screen.getByLabelText('Search')).toBe(input);
  });

  it('honours a custom placeholder for both placeholder and aria-label', () => {
    render(<SearchInput value="" onChange={jest.fn()} placeholder="Find a token" />);

    const input = getInput();
    expect(input.getAttribute('placeholder')).toBe('Find a token');
    expect(input.getAttribute('aria-label')).toBe('Find a token');
  });
});

describe('SearchInput — container & input classes', () => {
  it('applies the base container classes when no className override is given', () => {
    const { container } = render(<SearchInput value="" onChange={jest.fn()} />);

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper.className).toContain('w-full');
    expect(wrapper.className).toContain('bg-gray-25');
    expect(wrapper.className).toContain('rounded-3xl');
    expect(wrapper.className).toContain('h-14');
  });

  it('appends a caller-supplied className onto the base container classes', () => {
    const { container } = render(<SearchInput value="" onChange={jest.fn()} className="my-extra-class" />);

    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('my-extra-class');
    // Base classes remain alongside the override.
    expect(wrapper.className).toContain('bg-gray-25');
  });

  it('always applies the fixed input styling classes', () => {
    render(<SearchInput value="" onChange={jest.fn()} />);

    const input = getInput();
    expect(input.className).toContain('bg-transparent');
    expect(input.className).toContain('outline-none');
    expect(input.className).toContain('text-center');
    expect(input.className).toContain('placeholder:text-placeholder-gray');
    expect(input.className).toContain('font-bold');
  });
});

describe('SearchInput — data-testid plumbing', () => {
  it('forwards data-testid to the input when provided', () => {
    render(<SearchInput value="" onChange={jest.fn()} data-testid="token-search" />);

    const input = screen.getByTestId('token-search');
    expect(input.tagName).toBe('INPUT');
    expect(input).toBe(getInput());
  });

  it('omits data-testid on the input when not provided', () => {
    render(<SearchInput value="" onChange={jest.fn()} />);

    expect(getInput().hasAttribute('data-testid')).toBe(false);
  });
});

describe('SearchInput — onChange behaviour', () => {
  it('calls onChange with the new input value on every change', () => {
    const onChange = jest.fn();
    render(<SearchInput value="" onChange={onChange} />);

    fireEvent.change(getInput(), { target: { value: 'abc' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('abc');
  });
});

describe('SearchInput — autoFocus', () => {
  it('renders without autoFocus by default', () => {
    render(<SearchInput value="" onChange={jest.fn()} />);
    // jsdom does not focus non-autoFocus inputs on mount.
    expect(document.activeElement).not.toBe(getInput());
  });

  it('focuses the input on mount when autoFocus is set', () => {
    render(<SearchInput value="" onChange={jest.fn()} autoFocus />);
    expect(document.activeElement).toBe(getInput());
  });
});

describe('SearchInput — inputMode variants', () => {
  it('leaves inputMode/autocapitalize/autocorrect/spellcheck unset when inputMode is undefined', () => {
    render(<SearchInput value="" onChange={jest.fn()} />);

    const input = getInput();
    expect(input.getAttribute('inputmode')).toBeNull();
    expect(input.getAttribute('autocapitalize')).toBeNull();
    expect(input.getAttribute('autocorrect')).toBeNull();
    // spellCheck undefined leaves the DOM property at its default (true) with no explicit attribute.
    expect(input.getAttribute('spellcheck')).not.toBe('false');
  });

  it('sets inputMode="text" without the URL-specific hardening attributes', () => {
    render(<SearchInput value="" onChange={jest.fn()} inputMode="text" />);

    const input = getInput();
    expect(input.getAttribute('inputmode')).toBe('text');
    expect(input.getAttribute('autocapitalize')).toBeNull();
    expect(input.getAttribute('autocorrect')).toBeNull();
    expect(input.getAttribute('spellcheck')).not.toBe('false');
  });

  it('sets inputMode="search" without the URL-specific hardening attributes', () => {
    render(<SearchInput value="" onChange={jest.fn()} inputMode="search" />);

    const input = getInput();
    expect(input.getAttribute('inputmode')).toBe('search');
    expect(input.getAttribute('autocapitalize')).toBeNull();
    expect(input.getAttribute('autocorrect')).toBeNull();
  });

  it('disables autocapitalize/autocorrect/spellcheck for inputMode="url"', () => {
    render(<SearchInput value="" onChange={jest.fn()} inputMode="url" />);

    const input = getInput();
    expect(input.getAttribute('inputmode')).toBe('url');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });
});

describe('SearchInput — Enter/onSubmit handling', () => {
  it('does not attach a keydown handler when onSubmit is omitted (Enter is a no-op)', () => {
    render(<SearchInput value="q" onChange={jest.fn()} />);

    // No handler wired: pressing Enter must not throw and preventDefault stays unset.
    const event = fireEvent.keyDown(getInput(), { key: 'Enter' });
    expect(event).toBe(true); // not prevented (fireEvent returns false only when defaultPrevented)
  });

  it('calls onSubmit and prevents default when Enter is pressed', () => {
    const onSubmit = jest.fn();
    render(<SearchInput value="q" onChange={jest.fn()} onSubmit={onSubmit} />);

    const notPrevented = fireEvent.keyDown(getInput(), { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // preventDefault was called, so fireEvent reports the event as prevented (returns false).
    expect(notPrevented).toBe(false);
  });

  it('ignores non-Enter keys while onSubmit is provided', () => {
    const onSubmit = jest.fn();
    render(<SearchInput value="q" onChange={jest.fn()} onSubmit={onSubmit} />);

    const notPrevented = fireEvent.keyDown(getInput(), { key: 'a' });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true); // default not prevented for non-Enter keys
  });
});
