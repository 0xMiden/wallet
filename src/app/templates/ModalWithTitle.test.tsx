import React from 'react';

import { render, screen } from '@testing-library/react';

import type { CustomModalProps } from 'app/atoms/CustomModal';

import ModalWithTitle from './ModalWithTitle';

// ---------------------------------------------------------------------------
// Mocks.
//
// ModalWithTitle.tsx is a thin presentational wrapper: it reads `compact` from
// `useAppEnv()`, then forwards `...restProps` (plus a composed `className`) to
// `CustomModal`, optionally rendering an <h1> title above the children body.
// We stub both collaborators so the only code executed (and measured) is
// ModalWithTitle.tsx itself — `clsx` runs for real so the class composition is
// exercised end-to-end.
//   - `app/env`: steerable `useAppEnv` mock to drive the `compact` branch
//     (px-4 when compact, px-6 otherwise).
//   - `app/atoms/CustomModal`: capture the props ModalWithTitle forwards (so we
//     can assert the composed `className` + any `...restProps` such as `isOpen`
//     / `onRequestClose` pass through) while rendering its children into the
//     DOM — this avoids pulling in the real react-modal / mobile-bubble chain.
// ---------------------------------------------------------------------------

const useAppEnvMock = jest.fn(() => ({ compact: false }));
jest.mock('app/env', () => ({
  useAppEnv: () => useAppEnvMock()
}));

// Capture the props CustomModal receives; render children + className so
// downstream assertions work.
const customModalPropsSpy = jest.fn();
jest.mock('app/atoms/CustomModal', () => ({
  __esModule: true,
  default: (props: CustomModalProps) => {
    customModalPropsSpy(props);
    const { children, className } = props;
    return (
      <div data-testid="custom-modal" className={className as string | undefined}>
        {children}
      </div>
    );
  }
}));

beforeEach(() => {
  customModalPropsSpy.mockClear();
  useAppEnvMock.mockReset();
  useAppEnvMock.mockReturnValue({ compact: false });
});

describe('ModalWithTitle', () => {
  it('renders the title as an <h1> with the title styling when `title` is provided', () => {
    render(
      <ModalWithTitle isOpen title="My Title">
        <span>body content</span>
      </ModalWithTitle>
    );

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('My Title');
    expect(heading).toHaveClass('mb-6', 'text-lg', 'font-medium', 'text-black', 'text-left');

    // Children are rendered inside the modal body wrapper.
    const body = screen.getByText('body content');
    expect(body).toBeInTheDocument();
  });

  it('renders a ReactNode title (not just a string)', () => {
    render(
      <ModalWithTitle isOpen title={<em data-testid="rich-title">rich</em>}>
        content
      </ModalWithTitle>
    );

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toContainElement(screen.getByTestId('rich-title'));
  });

  it('omits the <h1> entirely when no `title` is provided', () => {
    render(
      <ModalWithTitle isOpen>
        <span>only body</span>
      </ModalWithTitle>
    );

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByText('only body')).toBeInTheDocument();
  });

  it('omits the <h1> when `title` is an empty string (falsy branch)', () => {
    render(
      <ModalWithTitle isOpen title="">
        body
      </ModalWithTitle>
    );

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('renders children inside the body div with the body styling', () => {
    render(
      <ModalWithTitle isOpen>
        <span data-testid="child">hi</span>
      </ModalWithTitle>
    );

    const child = screen.getByTestId('child');
    const bodyDiv = child.parentElement;
    expect(bodyDiv).toHaveClass('text-black', 'text-sm', 'text-left');
  });

  it('applies `px-6` (non-compact) padding when `compact` is false', () => {
    useAppEnvMock.mockReturnValue({ compact: false });

    render(<ModalWithTitle isOpen>body</ModalWithTitle>);

    expect(customModalPropsSpy).toHaveBeenCalledTimes(1);
    const className = customModalPropsSpy.mock.calls[0][0].className as string;
    expect(className).toContain('px-6');
    expect(className).not.toContain('px-4');
    // Static layout classes are always present.
    expect(className).toContain('w-full');
    expect(className).toContain('max-w-md');
    expect(className).toContain('pb-4');
    expect(className).toContain('pt-5');
  });

  it('applies `px-4` (compact) padding when `compact` is true', () => {
    useAppEnvMock.mockReturnValue({ compact: true });

    render(<ModalWithTitle isOpen>body</ModalWithTitle>);

    const className = customModalPropsSpy.mock.calls[0][0].className as string;
    expect(className).toContain('px-4');
    expect(className).not.toContain('px-6');
  });

  it('appends the caller-supplied `className` after the composed base classes', () => {
    render(
      <ModalWithTitle isOpen className="custom-extra-class">
        body
      </ModalWithTitle>
    );

    const className = customModalPropsSpy.mock.calls[0][0].className as string;
    expect(className).toContain('custom-extra-class');
    // Base classes remain composed alongside the extra class.
    expect(className).toContain('w-full');
  });

  it('forwards every remaining prop (`...restProps`) to CustomModal untouched', () => {
    const onRequestClose = jest.fn();

    render(
      <ModalWithTitle isOpen onRequestClose={onRequestClose} title="T">
        body
      </ModalWithTitle>
    );

    const forwarded = customModalPropsSpy.mock.calls[0][0];
    expect(forwarded.isOpen).toBe(true);
    expect(forwarded.onRequestClose).toBe(onRequestClose);
    // `title` is consumed by ModalWithTitle and must NOT leak into CustomModal.
    expect('title' in forwarded).toBe(false);
  });
});
