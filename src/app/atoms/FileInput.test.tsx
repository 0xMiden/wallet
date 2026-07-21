import React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import FileInput from './FileInput';

// The visually-hidden <input type="file"> is the real control; the wrapping
// <div> carries the positioning classes and hosts `children`.
const getInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;
const getWrapper = (container: HTMLElement) => container.firstChild as HTMLElement;

// jsdom forbids programmatically setting a file input's value to anything but
// the empty string, so we simulate a selection by defining `files` directly —
// this is exactly what @testing-library's fireEvent.change does under the hood.
const makeFile = (name = 'seed.png') => new File(['data'], name, { type: 'image/png' });

describe('FileInput', () => {
  it('renders the wrapper, the hidden file input, and its children', () => {
    const { container } = render(
      <FileInput>
        <span data-testid="label">Pick a file</span>
      </FileInput>
    );
    const wrapper = getWrapper(container);
    const input = getInput(container);

    // Wrapper base classes.
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper).toHaveClass('relative');
    expect(wrapper).toHaveClass('w-full');

    // Hidden file input with its overlay styling.
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveClass('appearance-none');
    expect(input).toHaveClass('absolute');
    expect(input).toHaveClass('inset-0');
    expect(input).toHaveClass('w-full');
    expect(input).toHaveClass('opacity-0');
    expect(input).toHaveClass('cursor-pointer');

    // Children render inside the wrapper.
    expect(screen.getByTestId('label')).toHaveTextContent('Pick a file');
  });

  it('merges a custom className onto the wrapper div', () => {
    const { container } = render(<FileInput className="my-drop-zone" />);
    const wrapper = getWrapper(container);

    expect(wrapper).toHaveClass('my-drop-zone');
    // Base classes are preserved alongside the custom one.
    expect(wrapper).toHaveClass('relative');
    expect(wrapper).toHaveClass('w-full');
  });

  it('passes the rest props through to the underlying input', () => {
    const { container } = render(
      <FileInput accept="image/png" multiple name="upload" disabled data-testid="file-ctrl" />
    );
    const input = getInput(container);

    expect(input).toHaveAttribute('accept', 'image/png');
    expect(input).toHaveAttribute('multiple');
    expect(input).toHaveAttribute('name', 'upload');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('data-testid', 'file-ctrl');
  });

  it('invokes onChange with the FileList when files are selected', () => {
    const onChange = jest.fn();
    const { container } = render(<FileInput onChange={onChange} />);
    const input = getInput(container);
    const files = [makeFile()];

    fireEvent.change(input, { target: { files } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(input.files);
    expect(input.files).toHaveLength(1);
  });

  it('does not call onChange when the selection is empty (length 0 branch)', () => {
    const onChange = jest.fn();
    const { container } = render(<FileInput onChange={onChange} />);

    fireEvent.change(getInput(container), { target: { files: [] } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not call onChange when files is falsy (null branch)', () => {
    const onChange = jest.fn();
    const { container } = render(<FileInput onChange={onChange} />);

    fireEvent.change(getInput(container), { target: { files: null } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not throw when files are selected without an onChange handler (optional-chaining branch)', () => {
    const { container } = render(<FileInput />);
    const input = getInput(container);

    expect(() => fireEvent.change(input, { target: { files: [makeFile()] } })).not.toThrow();
    expect(input.files).toHaveLength(1);
  });

  it('resets the input value via the effect when no value prop is given (nullish-coalesce branch)', () => {
    // With value === undefined the effect runs `ref.current.value = value ?? []`,
    // taking the right-hand `[]` which coerces to "" — a legal assignment for a
    // file input in jsdom (asserting it did not throw during mount).
    const { container } = render(<FileInput />);
    const input = getInput(container);

    expect(input.value).toBe('');
    expect(input.files).toHaveLength(0);
  });

  it('runs the effect assignment when a (non-nullish) value prop is provided', () => {
    // An empty array is non-nullish, so `value ?? []` keeps the passed value;
    // it coerces to "" and is a legal assignment. This exercises the left-hand
    // operand of the nullish coalescing without tripping jsdom's file-value guard.
    const emptyValue = [] as unknown as FileList;
    const { container } = render(<FileInput value={emptyValue} />);
    const input = getInput(container);

    expect(input.value).toBe('');
  });

  it('skips the effect assignment when value already equals the input files (identity branch)', () => {
    // First mount with no value; after effects settle, capture the input's own
    // (stable) FileList and feed it back as `value`. Now `value === ref.current.files`,
    // so the `if` condition is false and the assignment is skipped.
    const { container, rerender } = render(<FileInput />);
    const input = getInput(container);
    const sameFiles = input.files as unknown as FileList;

    expect(() => rerender(<FileInput value={sameFiles} />)).not.toThrow();
    expect(input.files).toBe(sameFiles);
  });

  it('re-runs the effect when the value prop transitions between renders', () => {
    const { container, rerender } = render(<FileInput />);
    const input = getInput(container);

    // Transition undefined -> [] -> undefined; each legal assignment leaves the
    // control cleared and must not throw.
    rerender(<FileInput value={[] as unknown as FileList} />);
    rerender(<FileInput />);

    expect(input.value).toBe('');
  });
});
