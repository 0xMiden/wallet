import React, { createRef } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';

import FormCheckbox from './FormCheckbox';

// FormCheckbox renders the real `Checkbox` atom, which pulls in
// `lib/mobile/haptics` (native @capacitor/haptics) and an inline SVG. We stub
// the child so this suite exercises FormCheckbox's own branches in isolation
// and can assert on the exact props it forwards (ref, `errored`, ...rest).
// The stub forwards the ref onto a real <input type="checkbox"> and mirrors
// `errored` / passthrough props onto DOM attributes so they are observable.
jest.mock('app/atoms/Checkbox', () => {
  const ReactLib = require('react');
  return {
    __esModule: true,
    default: ReactLib.forwardRef(({ errored, className, ...rest }: any, ref: any) =>
      ReactLib.createElement('input', {
        ref,
        type: 'checkbox',
        'data-testid': 'checkbox',
        'data-errored': String(errored),
        className,
        ...rest
      })
    )
  };
});

const getRoot = (container: HTMLElement) => container.firstChild as HTMLElement;
const getLabel = (container: HTMLElement) => container.querySelector('label') as HTMLLabelElement;
const getCheckbox = () => screen.getByTestId('checkbox') as HTMLInputElement;

describe('FormCheckbox', () => {
  it('renders the bare checkbox with no label / description / error', () => {
    const { container } = render(<FormCheckbox />);

    const root = getRoot(container);
    expect(root).toHaveClass('flex', 'flex-col');

    const label = getLabel(container);
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass('p-4', 'overflow-hidden', 'cursor-pointer', 'flex', 'items-center');

    // No label prop -> the label text/description block is not rendered.
    expect(label.querySelector('div')).toBeNull();

    // No errorCaption -> errored is false and no error caption div.
    const checkbox = getCheckbox();
    expect(checkbox).toHaveAttribute('data-errored', 'false');
    expect(container.querySelector('.text-red-500')).toBeNull();
  });

  it('renders the label with its wrapper and text styling', () => {
    const { container } = render(<FormCheckbox label="Accept terms" />);

    const labelText = screen.getByText('Accept terms');
    expect(labelText).toBeInTheDocument();
    expect(labelText).toHaveClass('text-sm', 'font-semibold', 'text-black');

    // The label text lives inside the ml-4 wrapper div; no description span yet.
    const wrapper = labelText.parentElement as HTMLElement;
    expect(wrapper).toHaveClass('ml-4', 'leading-tight', 'flex', 'flex-col');
    expect(wrapper.querySelectorAll('span')).toHaveLength(1);

    // labelDescription falsy branch: only the single label span exists.
    expect(container.querySelectorAll('label span')).toHaveLength(1);
  });

  it('renders the label description when both label and description are provided', () => {
    render(<FormCheckbox label="Accept terms" labelDescription="You must agree to continue" />);

    const description = screen.getByText('You must agree to continue');
    expect(description).toBeInTheDocument();
    expect(description).toHaveClass('mt-1', 'text-sm', 'text-black');
  });

  it('does not render a description block when only labelDescription is set (no label)', () => {
    // With no `label`, the whole label block (and thus the description) is null.
    render(<FormCheckbox labelDescription="orphan description" />);

    expect(screen.queryByText('orphan description')).not.toBeInTheDocument();
  });

  it('renders the error caption and marks the checkbox as errored', () => {
    const { container } = render(<FormCheckbox errorCaption="This field is required" />);

    const caption = screen.getByText('This field is required');
    expect(caption).toBeInTheDocument();
    expect(caption).toHaveClass('text-xs', 'text-red-500');

    // Boolean(errorCaption) -> true forwarded as `errored`.
    expect(getCheckbox()).toHaveAttribute('data-errored', 'true');
    expect(container.querySelector('.text-red-500')).toBe(caption);
  });

  it('treats an empty-string errorCaption as no error (falsy branch)', () => {
    const { container } = render(<FormCheckbox errorCaption="" />);

    // Empty string is falsy: no caption div, errored is false.
    expect(container.querySelector('.text-red-500')).toBeNull();
    expect(getCheckbox()).toHaveAttribute('data-errored', 'false');
  });

  it('applies containerClassName and labelClassName', () => {
    const { container } = render(<FormCheckbox containerClassName="my-container" labelClassName="my-label" />);

    expect(getRoot(container)).toHaveClass('flex', 'flex-col', 'my-container');
    expect(getLabel(container)).toHaveClass('p-4', 'my-label');
  });

  it('forwards the ref to the underlying checkbox input', () => {
    const ref = createRef<HTMLInputElement>();
    render(<FormCheckbox ref={ref} />);

    expect(ref.current).toBe(getCheckbox());
    expect(ref.current?.type).toBe('checkbox');
  });

  it('passes through arbitrary rest props and fires onChange', () => {
    const onChange = jest.fn();
    render(<FormCheckbox name="agree" checked onChange={onChange} data-extra="x" />);

    const checkbox = getCheckbox();
    expect(checkbox).toHaveAttribute('name', 'agree');
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute('data-extra', 'x');

    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders label, description and error caption together', () => {
    const { container } = render(
      <FormCheckbox
        label="Full label"
        labelDescription="Full description"
        errorCaption="Full error"
        containerClassName="c"
        labelClassName="l"
      />
    );

    expect(screen.getByText('Full label')).toBeInTheDocument();
    expect(screen.getByText('Full description')).toBeInTheDocument();
    expect(screen.getByText('Full error')).toBeInTheDocument();
    expect(getCheckbox()).toHaveAttribute('data-errored', 'true');
    expect(getRoot(container)).toHaveClass('c');
    expect(getLabel(container)).toHaveClass('l');
  });
});
